import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ObjectId } from 'mongodb';
import Stripe from "stripe";
import jwt from "jsonwebtoken";
import cron from "node-cron";

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.error("Failed to connect to MongoDB:", err);
    throw err;
  }
}

const connectedClient = await connectToMongoDB();

const database = connectedClient.db("equipment_rental_platform");
const users = database.collection("user");
const sessions = database.collection("session");
const equipments = database.collection("equipment");
const payments = database.collection("payments");
const rentals = database.collection("rental");


const COMPLETED_STATUS = "Completed";

const FINAL_STATUSES = /^(completed|cancelled)$/i;


function overdueBookingFilter(now = new Date()) {
 
  const startOfTodayUTC = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const dateOnly = startOfTodayUTC.toISOString().slice(0, 10); // for string dates

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
          { bookingStatus: { $not: FINAL_STATUSES } },
        ],
      },
    ],
  };
}

/** Complete every overdue booking and restock its equipment. */
async function updateOverdueBookings() {
  const now = new Date();
  const filter = overdueBookingFilter(now);
  const overdue = await rentals.find(filter).toArray();

  let updated = 0;
  let restocked = 0;

  for (const rental of overdue) {

    const updatedDoc = await rentals.findOneAndUpdate(
      { _id: rental._id, ...filter },
      {
        $set: {
          bookingStatus: COMPLETED_STATUS,
          completedAt: now,
          updatedAt: now,
        },
      },
      { returnDocument: "after" }
    );
    const doc = updatedDoc?.value ?? updatedDoc; // works with old and new Mongo drivers
    if (!doc || String(doc.bookingStatus).toLowerCase() !== "completed") continue;
    updated += 1;

    const quantity = Number(rental.quantity) || 1;
    const equipmentId = rental.equipmentId;
    if (equipmentId && ObjectId.isValid(String(equipmentId)) && quantity > 0) {
      const result = await equipments.updateOne(
        { _id: new ObjectId(String(equipmentId)) },
        { $inc: { availableQuantity: quantity } }
      );
      if (result.modifiedCount > 0) restocked += 1;
    }
  }

  return { scanned: overdue.length, updated, restocked, at: now.toISOString() };
}

function startBookingStatusCron() {
  const schedule = process.env.BOOKING_CRON_SCHEDULE || "0 * * * *";
  const timezone = process.env.BOOKING_CRON_TIMEZONE || "UTC";

  if (!cron.validate(schedule)) {
    throw new Error(`Invalid BOOKING_CRON_SCHEDULE: "${schedule}"`);
  }

  let running = false;
  async function run(trigger) {
    if (running) return; // skip overlapping runs
    running = true;
    try {
      const result = await updateOverdueBookings();
      console.log(
        `[CRON] ${trigger}: scanned=${result.scanned} ` +
          `completed=${result.updated} restocked=${result.restocked}`
      );
      return result;
    } catch (err) {
      console.error(`[CRON] ${trigger} failed:`, err);
    } finally {
      running = false;
    }
  }

  cron.schedule(schedule, () => run("scheduled"), { timezone });
  console.log(`[CRON] Booking status job scheduled: "${schedule}" (${timezone})`);

  if (process.env.BOOKING_CRON_RUN_ON_START !== "false") {
    setTimeout(() => run("startup"), 1000).unref?.();
  }
}

startBookingStatusCron();

const app = express();
const port = process.env.PORT || 5000;

app.use(express.json());
app.use(cors());

app.get("/", (req, res) => {
  res.send(" Rental Platform Server is running");
});



const verifyToken = async (req, res, next) => {
  const header = req.headers.authorization;
  const token =
    header && header.toLowerCase().startsWith("bearer ")
      ? header.slice(7).trim()
      : null;

  if (!token) {
    return res.status(401).send({ error: "Unauthorized" });
  }

 
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    return next();
  } catch {
  }

  try {
    const sessionDoc = await sessions.findOne({
      token,
      expiresAt: { $gt: new Date() },
    });
    if (!sessionDoc) {
      return res.status(401).send({ error: "Unauthorized" });
    }

    const userId =
      sessionDoc.userId instanceof ObjectId
        ? sessionDoc.userId
        : new ObjectId(sessionDoc.userId);
    const userDoc = await users.findOne({ _id: userId });
    if (!userDoc) {
      return res.status(401).send({ error: "Unauthorized" });
    }

    req.user = { ...userDoc, id: userDoc._id.toString() };
    return next();
  } catch (err) {
    console.error("Session token verification failed:", err);
    return res.status(401).send({ error: "Unauthorized" });
  }
};

const verifyRenter = (req, res, next) => {
  if (!req.user || req.user.role !== "Customer") {
    return res.status(403).send({ error: "Customer access only" });
  }
  next();
};

const verifyOwner = (req, res, next) => {
  if (!req.user || req.user.role !== "Owner") {
    return res.status(403).send({ error: "Owner access only" });
  }
  next();
};


const verifyOwnerOrAdmin = (req, res, next) => {
  if (!req.user || !["Owner", "Admin"].includes(req.user.role)) {
    return res.status(403).send({
      error: "Owner or Admin access required",
    });
  }
  next();
};

// The Admin dashboard's All Rentals page edits the payment and booking
// status of every booking, so Admins are allowed as well as Customers.
const verifyCustomerOrAdmin = (req, res, next) => {
  if (!req.user || !["Customer", "Admin"].includes(req.user.role)) {
    return res.status(403).send({
      error: "Customer or Admin access required",
    });
  }
  next();
};

const verifyAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "Admin") {
    return res.status(403).send({ error: "Admin access only" });
  }
  next();
};

// Users are only exposed through the admin endpoints.
app.get("/users", verifyAdmin, async (req, res) => {
    const usersData = users.find({});
    const usersArray = await usersData.toArray();
    res.send(usersArray);
});


// Owner equipment add
app.post("/add-equipment",verifyToken,verifyOwner, async (req, res) => {
  try {
    const equipmentData = req.body;
    const result = await equipments.insertOne(equipmentData);
    res.send(result);
  } catch (err) {
    console.error("Error adding equipment:", err);
    res.status(500).send({ error: "Failed to add equipment" });
  }
});



app.get("/equipment", async (req, res) => {
 
  try {
    const query = buildEquipmentQuery(req.query);

    const sortParam = String(req.query.sort || "recent").toLowerCase();
    const sortMap = {
      pricelow: { rentalPrice: 1, _id: 1 },
      pricehigh: { rentalPrice: -1, _id: -1 },
      recent: { createdAt: -1, _id: -1 },
    };
    const sort = sortMap[sortParam] || sortMap.recent;

    const equipmentArray = await equipments
      .find(query)
      .sort(sort)
      .toArray();

    res.status(200).send(equipmentArray);
  } catch (err) {
    console.error("Error fetching equipment:", err);
    res.status(500).send({
      error: "Failed to fetch equipment",
    });
  }
});




app.get("/equipment/categories", async (req, res) => {
  try {
    const rest = { ...req.query };
    delete rest.category;

    const query = buildEquipmentQuery(rest);

    const rows = await equipments
      .aggregate([
        { $match: query },
        { $group: { _id: "$category", count: { $sum: 1 } } },
        { $match: { _id: { $nin: [null, ""] } } },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    res
      .status(200)
      .send(rows.map((row) => ({ name: row._id, count: row.count })));
  } catch (err) {
    console.error("Error fetching equipment categories:", err);
    res.status(500).send({ error: "Failed to fetch categories" });
  }
});


// Single equipment item by id — public: the equipment listing pages are
// browsable without an account, so the details page must be too.
app.get("/equipment/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(404).send({ error: "Equipment not found" });
    }

    const equipment = await equipments.findOne({ _id: new ObjectId(id) });

    if (!equipment) {
      return res.status(404).send({ error: "Equipment not found" });
    }

    res.status(200).send(equipment);
  } catch (err) {
    console.error("Error fetching equipment:", err);
    res.status(500).send({ error: "Failed to fetch equipment" });
  }
});


//  Rentals API

// GET /rentals?userId=... — bookings of one customer, newest first
app.get("/rentals",verifyToken, verifyRenter, async (req, res) => {
  try {
    const userId = String(req.user?.id || "");

    if (!userId) {
      return res.status(400).send({ error: "userId is required" });
    }

    const list = await rentals
      .find({ customerId: userId })
      .sort({ bookingDate: -1 })
      .toArray();

    res.status(200).send(list);
  } catch (err) {
    console.error("Error fetching rentals:", err);
    res.status(500).send({ error: "Failed to fetch rentals" });
  }
});

// GET /rentals/:id — one booking (used by the payment page)
app.get("/rentals/:id",verifyToken, verifyRenter, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(404).send({ error: "Booking not found" });
    }

    const booking = await rentals.findOne({ _id: new ObjectId(id) });

    if (!booking) {
      return res.status(404).send({ error: "Booking not found" });
    }

    res.status(200).send(booking);
  } catch (err) {
    console.error("Error fetching booking:", err);
    res.status(500).send({ error: "Failed to fetch booking" });
  }
});


// ET /owner/rentals — all customer bookings for the logged-in owner's equipment
app.get("/owner/rentals", verifyToken, verifyOwner, async (req, res) => {
  try {
    const { ownerId } = req.query;

    if (!ownerId) {
      return res.status(400).send({ error: "ownerId is required" });
    }

    // Always scope the query to the caller's own owner id — a passed
    // value cannot widen visibility to other owners' rentals.
    const scopedOwnerId = String(req.user?.id || ownerId);

    const ownerEquipmentIds = await equipments
      .find({ ownerId: String(scopedOwnerId) }, { projection: { _id: 1 } })
      .toArray();

    const equipmentIdList = ownerEquipmentIds.map((item) => item._id.toString());

    const orderRentals = await rentals
      .find({ equipmentId: { $in: equipmentIdList } })
      .sort({ bookingDate: -1 })
      .toArray();
      
    res.status(200).send(orderRentals);
  } catch (err) {
    console.error("Error fetching owner rentals:", err);
    res.status(500).send({ error: "Failed to fetch owner rentals" });
  }
});



// PATCH /rentals/:id — update payment/booking status (e.g. after Stripe payment)
app.patch("/rentals/:id", verifyToken, verifyCustomerOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(404).send({ error: "Booking not found" });
    }

    const booking = await rentals.findOne({ _id: new ObjectId(id) });
    if (!booking) {
      return res.status(404).send({ error: "Booking not found" });
    }

    // A customer may update only their own bookings; Admins are allowed
    // to update every booking (see verifyCustomerOrAdmin).
    if (
      String(booking.customerId) !== String(req.user?.id) &&
      req.user.role !== "Admin"
    ) {
      return res.status(404).send({ error: "Booking not found" });
    }

    const updates = {};
    const requestedPaymentStatus = req.body.paymentStatus
      ? String(req.body.paymentStatus)
      : "";
    if (requestedPaymentStatus) {
      updates.paymentStatus = requestedPaymentStatus;
    }

    // A successful payment confirms a still-pending booking. This is done on
    // the server so the status cannot be forgotten by a client, and a refresh
    // of the success page can never downgrade an already Completed/Cancelled
    // booking back to Confirmed.
    if (
      requestedPaymentStatus.toLowerCase() === "paid" &&
      String(booking.bookingStatus || "").toLowerCase() === "pending"
    ) {
      updates.bookingStatus = "Confirmed";
    }

    if (req.body.bookingStatus) {
      updates.bookingStatus = String(req.body.bookingStatus);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).send({ error: "Nothing to update" });
    }

    const result = await rentals.updateOne(
      { _id: new ObjectId(id) },
      { $set: updates }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ error: "Booking not found" });
    }

    res.status(200).send({ modifiedCount: result.modifiedCount });
  } catch (err) {
    console.error("Error updating booking:", err);
    res.status(500).send({ error: "Failed to update booking" });
  }
});

// POST /rentals — a customer rents an equipment for a date range
app.post("/rentals", verifyToken, verifyRenter, async (req, res) => {
  try {
    const {
      equipmentId,
      equipmentName,
      customerId,
      customerName,
      startDate,
      endDate,
      quantity,
      rentalPrice,
      rentalType,
      contactNumber,
      deliveryAddress,
      notes,
    } = req.body;

    if (!equipmentId || !customerId || !startDate || !endDate) {
      return res.status(400).send({
        error: "equipmentId, customerId, startDate and endDate are required",
      });
    }

    // A customer cannot book equipment on behalf of another account.
    if (String(customerId) !== String(req.user?.id)) {
      return res.status(403).send({
        error: "You can only book equipment for your own account.",
      });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
      return res.status(400).send({ error: "Invalid rental dates" });
    }

    // The equipment must exist and the booking must stay within stock.
    if (!ObjectId.isValid(equipmentId)) {
      return res.status(400).send({ error: "Invalid equipmentId" });
    }

    const equipment = await equipments.findOne({
      _id: new ObjectId(equipmentId),
    });

    if (!equipment) {
      return res.status(404).send({ error: "Equipment not found" });
    }

    const qty = Math.max(1, Number(quantity) || 1);

    if (
      !Number.isInteger(equipment.availableQuantity) ||
      equipment.availableQuantity <= 0
    ) {
      return res.status(400).send({ error: "Equipment is out of stock" });
    }

    if (qty > equipment.availableQuantity) {
      return res.status(400).send({
        error: `Only ${equipment.availableQuantity} unit(s) available to rent`,
      });
    }
    const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000));

    // The equipment's canonical price is the source of truth — the
    // client-supplied price is not used.
    const price = Number(equipment.rentalPrice) || 0;

    // Price of the whole window, priced by the item's rental type
    // (values are stored capitalized, but tolerate other cases).
    const rentalTypeValue =
      typeof rentalType === "string" ? rentalType.toLowerCase() : "";
    let units = days;
    if (rentalTypeValue === "weekly") units = Math.ceil(days / 7);
    if (rentalTypeValue === "monthly") units = Math.ceil(days / 30);

    const rental = {
      equipmentId: String(equipmentId),
      equipmentName: equipmentName || "Equipment",
      customerId: String(customerId),
      customerName: customerName || "",
      startDate,
      endDate,
      quantity: qty,
      days,
      totalAmount: price * units * qty,
      contactNumber: contactNumber || "",
      deliveryAddress: deliveryAddress || "",
      notes: notes || "",
      paymentStatus: "Pending",
      bookingStatus: "Pending",
      bookingDate: new Date(),
    };

    // Consume the booked quantity atomically so concurrent bookings
    // cannot oversell. If another request took the stock first, say so.
    const consumed = await equipments.findOneAndUpdate(
      { _id: equipment._id, availableQuantity: { $gte: qty } },
      { $inc: { availableQuantity: -qty } }
    );
    if (!consumed) {
      return res.status(409).send({
        error: `Only ${equipment.availableQuantity} unit(s) available to rent`,
      });
    }

    let result;
    try {
      result = await rentals.insertOne(rental);
    } catch (err) {
      // Give the consumed stock back if the booking could not be saved.
      await equipments.updateOne(
        { _id: equipment._id },
        { $inc: { availableQuantity: qty } }
      );
      throw err;
    }

    res.status(201).send({ ...rental, _id: result.insertedId });
  } catch (err) {
    console.error("Error creating rental:", err);
    res.status(500).send({ error: "Failed to create rental" });
  }
});


// Favorites API
const favorites = database.collection("favorite");

// GET /favorites?userId=...&equipmentId=...  (equipmentId is optional)
// Returns the saved items with the current equipment record joined in.
app.get("/favorites",verifyToken, verifyRenter, async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const equipmentId = req.query.equipmentId;

    if (!userId) {
      return res.status(400).send({ error: "userId is required" });
    }

    const match = { userId: String(userId) };

    if (equipmentId && ObjectId.isValid(equipmentId)) {
      match.equipmentId = new ObjectId(equipmentId);
    }

    const rows = await favorites
      .aggregate([
        { $match: match },
        { $sort: { favoritedAt: -1 } },
        {
          $lookup: {
            from: "equipment",
            localField: "equipmentId",
            foreignField: "_id",
            as: "equipment",
          },
        },
        {
          $unwind: { path: "$equipment", preserveNullAndEmptyArrays: true },
        },
      ])
      .toArray();

    res.status(200).send(rows);
  } catch (err) {
    console.error("Error fetching favorites:", err);
    res.status(500).send({ error: "Failed to fetch favorites" });
  }
});

// POST /favorites — save an equipment to a customer's favorites
app.post("/favorites", verifyToken, verifyRenter, async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const equipmentId = req.body?.equipmentId;

    if (!userId || !equipmentId || !ObjectId.isValid(equipmentId)) {
      return res.status(400).send({
        error: "userId and a valid equipmentId are required",
      });
    }

    const owner = String(userId);
    const equipment = new ObjectId(equipmentId);

    // Already saved? Return it instead of creating a duplicate.
    const existing = await favorites.findOne({
      userId: owner,
      equipmentId: equipment,
    });

    if (existing) return res.status(200).send(existing);

    const doc = {
      userId: owner,
      equipmentId: equipment,
      favoritedAt: new Date(),
    };

    const result = await favorites.insertOne(doc);

    res.status(201).send({ ...doc, _id: result.insertedId });
  } catch (err) {
    console.error("Error adding favorite:", err);
    res.status(500).send({ error: "Failed to add favorite" });
  }
});

// DELETE /favorites/:id — remove one saved item
app.delete("/favorites/:id", verifyToken, verifyRenter, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(404).send({ error: "Favorite not found" });
    }

    // Only the owning customer can remove their own favorite.
    const result = await favorites.deleteOne({
      _id: new ObjectId(id),
      userId: String(req.user?.id || ""),
    });

    if (result.deletedCount === 0) {
      return res.status(404).send({ error: "Favorite not found" });
    }

    res.status(200).send({ deletedCount: result.deletedCount });
  } catch (err) {
    console.error("Error removing favorite:", err);
    res.status(500).send({ error: "Failed to remove favorite" });
  }
});



// customer payment information API — save Stripe transaction after successful payment
 
app.post("/payments", verifyToken,verifyRenter, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).send({ error: "Stripe is not configured." });
    }

    const { rentalId } = req.body;

    // Validate rental ID
    if (!rentalId || !ObjectId.isValid(rentalId)) {
      return res.status(400).send({
        error: "Valid rental ID is required",
      });
    }

    // Find rental
    const rental = await rentals.findOne({
      _id: new ObjectId(rentalId),
    });

    if (!rental) {
      return res.status(404).send({
        error: "Rental not found",
      });
    }

    // A customer can only start a session for their own bookings.
    if (String(rental.customerId) !== String(req.user?.id)) {
      return res.status(404).send({
        error: "Rental not found",
      });
    }

    // Check payment status
    if (rental.paymentStatus === "Paid") {
      return res.status(400).send({
        error: "This rental is already paid",
      });
    }

    // Validate rental amount
    if (!Number.isFinite(rental.totalAmount) || rental.totalAmount <= 0) {
      return res.status(400).send({
        error: "Invalid rental amount",
      });
    }

    // Create Stripe Checkout Session
    const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";
    const session = await stripe.checkout.sessions.create({
      mode: "payment",

      line_items: [
        {
          price_data: {
            currency: "BDT",
            product_data: {
              name: rental.equipmentName,
              description: `${rental.days} days rental`,
            },
            unit_amount: Math.round(rental.totalAmount * 100),
          },
          quantity: rental.quantity || 1,
        },
      ],

      client_reference_id: rental._id.toString(),
      metadata: {
        rentalId: rental._id.toString(),
      },

      success_url: `${clientUrl}/success?session_id={CHECKOUT_SESSION_ID}`,

      cancel_url: `${clientUrl}/dashboard/customer/payment/${rental._id}`,
    });

    // Save payment information
    await payments.insertOne({
      rentalId: rental._id.toString(),
      customerId: rental.customerId,
      equipmentId: rental.equipmentId,
      equipmentName: rental.equipmentName,
      stripeSessionId: session.id,
      amount: rental.totalAmount,
      currency: "BDT",
      paymentStatus: "Pending",
      transactionDate: new Date(),
    });

    res.status(201).send({
      checkoutUrl: session.url,
    });

  } catch (err) {
    console.error("Payment error:", err);

    res.status(500).send({
      error: "Failed to create payment session",
    });
  }
});


// POST /api/payments/record — called by the Stripe success page after the
// session is verified. Marks the booking paid/confirmed and stores the
// transaction exactly once (safe to call again when the page is refreshed).
app.post("/api/payments/record", verifyToken, verifyRenter, async (req, res) => {
  try {
    const { rentalId, stripeSessionId, amount, currency } = req.body || {};
    if (!rentalId || !ObjectId.isValid(rentalId) || !stripeSessionId) {
      return res.status(400).send({
        error: "Valid rentalId and stripeSessionId are required",
      });
    }

    const rental = await rentals.findOne({ _id: new ObjectId(rentalId) });
    if (!rental) {
      return res.status(404).send({ error: "Rental not found" });
    }
    if (String(rental.customerId) !== String(req.user?.id)) {
      return res.status(404).send({ error: "Rental not found" });
    }

    // Idempotency: one transaction per Stripe session.
    const existing = await payments.findOne({
      rentalId: String(rentalId),
      stripeSessionId: String(stripeSessionId),
    });
    if (existing) {
      return res.send({ created: false, payment: existing });
    }

    const paidAmount = Number(amount ?? rental.totalAmount);
    if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
      return res.status(400).send({ error: "Invalid payment amount" });
    }

    const bookingUpdates = { paymentStatus: "Paid" };
    if (String(rental.bookingStatus || "").toLowerCase() === "pending") {
      bookingUpdates.bookingStatus = "Confirmed";
    }
    await rentals.updateOne({ _id: rental._id }, { $set: bookingUpdates });

    const record = {
      rentalId: String(rentalId),
      customerId: String(rental.customerId),
      equipmentId: String(rental.equipmentId || ""),
      equipmentName: rental.equipmentName || "",
      stripeSessionId: String(stripeSessionId),
      amount: paidAmount,
      currency: String(currency || "bdt"),
      paymentStatus: "Paid",
      transactionDate: new Date(),
    };
    const result = await payments.insertOne(record);
    res.status(201).send({
      created: true,
      payment: { ...record, _id: result.insertedId },
    });
  } catch (err) {
    console.error("Error recording payment:", err);
    res.status(500).send({ error: "Failed to record payment" });
  }
});

// GET all payment transactions
app.get("/payments", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const paymentsList = await payments
      .find({})
      .sort({ transactionDate: -1 })
      .toArray();

    res.status(200).send(paymentsList);
  } catch (err) {
    console.error("Error fetching payments:", err);
    res.status(500).send({ error: "Failed to fetch payments" });
  }
});



app.patch("/equipment/:id", verifyToken, verifyOwnerOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ error: "Invalid equipment id." });
    }

    const updateData = {...req.body};

    delete updateData._id; 

    const result = await equipments.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ error: "Equipment not found" });
    }

    res.status(200).send(result);
  } catch (err) {
    console.error("Error updating equipment:", err);
    res.status(500).send({ error: "Failed to update equipment" });
  }
});



app.delete("/equipment/:id", verifyToken, verifyOwnerOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ error: "Invalid equipment id." });
    }

    const result = await equipments.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).send({ error: "Equipment not found" });
    }

    res.status(200).send(result);
  } catch (err) {
    console.error("Error deleting equipment:", err);
    res.status(500).send({ error: "Failed to delete equipment" });
  }
});



// admin routes
// all users
app.get("/admin/users", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const usersData = users.find({});
    const usersArray = await usersData.toArray();
    res.send(usersArray);
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).send({ error: "Failed to fetch users" });
  }
});

// update a user's role
app.patch("/admin/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!ObjectId.isValid(id)) {
      res.status(400).send({ error: "Invalid user id." });
      return;
    }

    if (!["Customer", "Owner", "Admin"].includes(role)) {
      res.status(400).send({ error: "Invalid role." });
      return;
    }

    const result = await users.updateOne(
      { _id: new ObjectId(id) },
      { $set: { role } }
    );

    if (result.matchedCount === 0) {
      res.status(404).send({ error: "User not found." });
      return;
    }

    res.send({ message: "User role updated." });
  } catch (err) {
    console.error("Error updating user role:", err);
    res.status(500).send({ error: "Failed to update user role" });
  }
});

// delete a user
app.delete("/admin/users/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      res.status(400).send({ error: "Invalid user id." });
      return;
    }

    const result = await users.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      res.status(404).send({ error: "User not found." });
      return;
    }

    res.send({ message: "User deleted." });
  } catch (err) {
    console.error("Error deleting user:", err);
    res.status(500).send({ error: "Failed to delete user" });
  }
});


// all equipment
app.get("/admin/equipment", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const equipmentData = equipments.find({});
    const equipmentArray = await equipmentData.toArray();
    res.send(equipmentArray);
  } catch (err) {
    console.error("Error fetching equipment:", err);
    res.status(500).send({ error: "Failed to fetch equipment" });
  }
});


// all rentals
app.get("/admin/rentals", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const rentalsData = rentals.find({});
    const rentalsArray = await rentalsData.toArray();
    res.send(rentalsArray);
  } catch (err) {
    console.error("Error fetching rentals:", err);
    res.status(500).send({ error: "Failed to fetch rentals" });
  }
});


// Manually run the overdue-booking sweep (handy for testing or when the
// long-running cron process is not available).
app.post(
  "/api/cron/update-booking-status",
  verifyToken,
  verifyAdmin,
  async (_req, res) => {
    try {
      const result = await updateOverdueBookings();
      res.status(200).send({
        message: "Booking status update completed",
        ...result,
      });
    } catch (err) {
      console.error("Error updating booking statuses:", err);
      res.status(500).send({ error: "Failed to update booking statuses" });
    }
  }
);

// get data from equipment database of the approval by admin
app.get("/featured-equipment", async (req, res) => {
  try {
    const featuredEquipment = await equipments
      .find({ status: "Approved" })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();

    res.send(featuredEquipment);
  } catch (error) {
    res.status(500).send({
      message: "Failed to fetch featured equipment",
    });
  }
});


  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });


export default app;