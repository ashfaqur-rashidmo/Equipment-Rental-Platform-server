import cron from "node-cron";
import { ObjectId } from "mongodb";

/** Canonical value written when a rental window has ended. */
export const COMPLETED_BOOKING_STATUS = "Completed";

/** Statuses that must never be re-opened by the sweep. */
const TERMINAL_STATUSES = /^(completed|cancelled)$/i;


export const buildOverdueFilter = (now = new Date()) => {
  const startOfTodayUTC = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const dateOnly = startOfTodayUTC.toISOString().slice(0, 10);

  return {
    $and: [
      {
        $or: [
          { endDate: { $type: "date", $lt: startOfTodayUTC } },
          { endDate: { $type: "string", $lt: dateOnly } },
        ],
      },
      {
        $or: [
          { bookingStatus: { $exists: false } },
          { bookingStatus: null },
          { bookingStatus: { $not: TERMINAL_STATUSES } },
        ],
      },
    ],
  };
};


export async function updateOverdueBookings(rentals, equipments, now = new Date()) {
  if (!rentals || typeof rentals.find !== "function") {
    throw new TypeError(
      "updateOverdueBookings requires a MongoDB rentals collection"
    );
  }

  const filter = buildOverdueFilter(now);
  const overdue = await rentals.find(filter).toArray();

  let updated = 0;
  let restocked = 0;

  for (const rental of overdue) {
    const result = await rentals.findOneAndUpdate(
      { _id: rental._id, ...filter },
      {
        $set: {
          bookingStatus: COMPLETED_BOOKING_STATUS,
          completedAt: now,
          updatedAt: now,
        },
      },
      { returnDocument: "after" }
    );

   
    const doc = result && "value" in result ? result.value : result;
    if (!doc || String(doc.bookingStatus).toLowerCase() !== "completed") {
      continue;
    }
    updated += 1;

    const equipmentId = rental.equipmentId;
    const qty = Number(rental.quantity) || 1;
    if (
      equipments &&
      equipmentId &&
      ObjectId.isValid(String(equipmentId)) &&
      qty > 0
    ) {
      const restock = await equipments.updateOne(
        { _id: new ObjectId(String(equipmentId)) },
        { $inc: { availableQuantity: qty } }
      );
      if (restock.modifiedCount > 0) restocked += 1;
    }
  }

  return {
    scanned: overdue.length,
    updated,
    restocked,
    at: now.toISOString(),
  };
}


export const startBookingStatusCron = ({
  rentals,
  equipments,
  schedule = process.env.BOOKING_CRON_SCHEDULE || "0 * * * *",
  timezone = process.env.BOOKING_CRON_TIMEZONE || "UTC",
  runOnStart = process.env.BOOKING_CRON_RUN_ON_START !== "false",
} = {}) => {
  if (!rentals || typeof rentals.find !== "function") {
    throw new TypeError(
      "startBookingStatusCron requires a MongoDB rentals collection"
    );
  }
  if (!cron.validate(schedule)) {
    throw new Error(`Invalid BOOKING_CRON_SCHEDULE value: "${schedule}"`);
  }

  let running = false;

  const run = async (trigger) => {
    if (running) {
      console.warn(`[CRON] ${trigger}: previous sweep still running, skipping`);
      return { skipped: true };
    }
    running = true;
    const startedAt = Date.now();
    try {
      const result = await updateOverdueBookings(rentals, equipments);
      console.log(
        `[CRON] ${trigger}: scanned=${result.scanned} completed=${result.updated} ` +
          `restocked=${result.restocked} (${Date.now() - startedAt}ms)`
      );
      return result;
    } catch (error) {
      console.error(`[CRON] ${trigger} failed:`, error);
      return { error: error.message };
    } finally {
      running = false;
    }
  };

  const task = cron.schedule(schedule, () => run("scheduled"), { timezone });
  console.log(`[CRON] Booking status job scheduled: "${schedule}" (${timezone})`);

  if (runOnStart) {
    // Let the HTTP server finish booting before the catch-up sweep.
    setTimeout(() => run("startup"), 1000).unref?.();
  }

  return { task, run };
};
