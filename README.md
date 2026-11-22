# Equipment Rental Platform — Server

Express + MongoDB REST API for the Equipment Rental Platform. It powers user
authentication and roles, equipment listings, rental bookings, Stripe payments,
analytics, and an automated booking-status cron job.

**Live client URL:** _(add your deployed frontend URL here, e.g. https://your-app.vercel.app)_

## Purpose

Equipment owners list their equipment for rent; customers browse, book and pay
for a rental period; admins manage users, equipment and rentals. This repository
is the backend for that marketplace.

## Key features

- Email/password registration & login with JWT access tokens, plus Google login
- Role-based access control (`Customer`, `Owner`, `Admin`) via `verifyToken`,
  `verifyRenter`, `verifyOwner`, `verifyOwnerOrAdmin`, `verifyCustomerOrAdmin`,
  `verifyAdmin` middlewares
- Equipment CRUD with image upload (ImgBB), categories and stock management
- Rental bookings with server-side price calculation and atomic stock updates
- Favorites, profiles and dashboards
- Stripe Checkout sessions; on success the booking is marked `Paid` /
  `Confirmed` and the transaction is stored in the `payments` collection
- Admin, owner and customer analytics endpoints
- `node-cron` job that completes bookings whose rental end date has passed and
  returns their units to stock (optional requirement #3)

## Getting started

```bash
npm install
npm start          # http://localhost:5000
```

Create a `.env` file with:

```env
MONGODB_URI=<your MongoDB connection string>
JWT_SECRET=<your JWT secret>
CLIENT_URL=http://localhost:3000
```

Optional cron settings:

```env
BOOKING_CRON_SCHEDULE=0 * * * *   # cron expression (default: hourly)
BOOKING_CRON_TIMEZONE=UTC         # IANA timezone
BOOKING_CRON_RUN_ON_START=false   # skip the startup catch-up sweep
```

## Cron job

The cron logic lives directly in `index.js` (no extra files). It runs hourly by
default, and admin can also trigger it any time from **Admin → All Rentals →
Update overdue bookings**, which calls `POST /api/cron/update-booking-status`.

## npm packages used

`express`, `cors`, `dotenv`, `mongodb`, `jsonwebtoken`, `stripe`, `node-cron`
