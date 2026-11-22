/**
 * Helper for UI testing:
 *   node mark-overdue.mjs                 -> list recent bookings (copy an ID)
 *   node mark-overdue.mjs <bookingId>     -> make that booking overdue
 *   node mark-overdue.mjs --undo <bookingId> -> restore a 7-day future window
 */
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 8000,
});

try {
  await client.connect();
  const rentals = client.db("equipment_rental_platform").collection("rental");
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--list") {
    const rows = await rentals
      .find({})
      .sort({ bookingDate: -1 })
      .limit(10)
      .toArray();
    console.log("Recent bookings:\n");
    for (const r of rows) {
      console.log(
        `${String(r._id).padEnd(26)} | ${String(r.bookingStatus).padEnd(10)} | ` +
          `${String(r.equipmentName).padEnd(22)} | end: ${String(r.endDate)}`
      );
    }
    console.log("\nRun: node mark-overdue.mjs <bookingId>");
  } else {
    const undo = args[0] === "--undo";
    const id = undo ? args[1] : args[0];
    if (!id || !ObjectId.isValid(id)) {
      throw new Error("Provide a valid 24-character booking ID.");
    }
    const now = new Date();
    const endDate = undo
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 7))
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
    const startDate = new Date(endDate.getTime() - 3 * 86400000);

    const result = await rentals.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { startDate, endDate, bookingStatus: "Confirmed" } },
      { returnDocument: "after" }
    );
    console.log(
      result
        ? `Updated ${id}: ${result.startDate.toISOString()} -> ${result.endDate.toISOString()} | ${result.bookingStatus}`
        : `No booking found with id ${id}`
    );
  }
} finally {
  await client.close();
}
