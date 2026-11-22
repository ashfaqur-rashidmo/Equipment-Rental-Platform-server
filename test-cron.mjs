/**
 * Self-contained verification for the booking-status cron.
 * Creates temporary test data, runs the sweep, asserts the results, then
 * removes everything it created. Run with: npm run test:cron
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { MongoClient, ObjectId } from "mongodb";
import { updateOverdueBookings } from "./bookingStatusCron.js";

const client = new MongoClient(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 8000,
});

const utcDay = (offsetDays) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + offsetDays));
};

try {
  await client.connect();
  const db = client.db("equipment_rental_platform");
  const rentals = db.collection("rental");
  const equipments = db.collection("equipment");

  const equipmentId = new ObjectId();
  const rentalIds = [new ObjectId(), new ObjectId(), new ObjectId()];

  await equipments.insertOne({
    _id: equipmentId,
    name: "__CRON_TEST_EQUIPMENT__",
    availableQuantity: 10,
  });

  await rentals.insertMany([
    {
      _id: rentalIds[0],
      equipmentId: String(equipmentId),
      customerId: "__CRON_TEST__",
      quantity: 2,
      startDate: utcDay(-6),
      endDate: utcDay(-1), // ended yesterday -> should become Completed
      bookingStatus: "Confirmed",
      paymentStatus: "Paid",
      bookingDate: new Date(),
      totalAmount: 100,
    },
    {
      _id: rentalIds[1],
      equipmentId: String(equipmentId),
      customerId: "__CRON_TEST__",
      quantity: 1,
      startDate: utcDay(1),
      endDate: utcDay(5), // still active -> must stay Confirmed
      bookingStatus: "Confirmed",
      paymentStatus: "Paid",
      bookingDate: new Date(),
      totalAmount: 50,
    },
    {
      _id: rentalIds[2],
      equipmentId: String(equipmentId),
      customerId: "__CRON_TEST__",
      quantity: 3,
      startDate: utcDay(-6),
      endDate: utcDay(-1), // ended but cancelled -> must stay Cancelled
      bookingStatus: "Cancelled",
      paymentStatus: "Pending",
      bookingDate: new Date(),
      totalAmount: 150,
    },
  ]);

  console.log("--- Before sweep ---");
  console.log("stock:", 10, "| statuses:", ["Confirmed", "Confirmed", "Cancelled"]);

  const result = await updateOverdueBookings(rentals, equipments);
  console.log("--- Sweep result ---", result);

  const after = await rentals.find({ _id: { $in: rentalIds } }).toArray();
  const byId = new Map(after.map((r) => [String(r._id), r]));
  const stock = await equipments.findOne({ _id: equipmentId });

  const statuses = rentalIds.map((id) => byId.get(String(id))?.bookingStatus);
  console.log("--- After sweep ---");
  console.log("statuses:", statuses, "| stock:", stock?.availableQuantity);

  assert.equal(statuses[0], "Completed", "ended booking should be Completed");
  assert.equal(statuses[1], "Confirmed", "future booking must stay Confirmed");
  assert.equal(statuses[2], "Cancelled", "cancelled booking must stay Cancelled");
  assert.equal(result.updated, 1, "exactly 1 booking should be updated");
  assert.equal(result.restocked, 1, "exactly 1 equipment should be restocked");
  assert.equal(stock?.availableQuantity, 12, "2 rented units should return to stock");

  console.log("\nPASS: cron logic works correctly.");
} finally {
  // Always clean up the temporary documents.
  if (client.topology?.isConnected()) {
    const db = client.db("equipment_rental_platform");
    await db.collection("rental").deleteMany({ customerId: "__CRON_TEST__" });
    await db.collection("equipment").deleteMany({ name: "__CRON_TEST_EQUIPMENT__" });
    console.log("Temporary test data removed.");
  }
  await client.close();
}
