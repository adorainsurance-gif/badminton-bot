require("dotenv").config();

const express = require("express");
const crypto = require("crypto");

const app = express();

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SQUARE_ENVIRONMENT =
  process.env.SQUARE_ENVIRONMENT || "sandbox";

const SQUARE_WEBHOOK_SIGNATURE_KEY =
  process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;

const BASE_URL =
  process.env.BASE_URL ||
  "https://badminton-bot-bjza.onrender.com";

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD;

const SUPABASE_URL =
  process.env.SUPABASE_URL;

const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY;

// ============================================================
// SQUARE API
// ============================================================

const SQUARE_API_BASE =
  SQUARE_ENVIRONMENT.toLowerCase() === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";

// ============================================================
// LOCAL CACHE
// ============================================================

let badmintonSession = {
  id: null,
  sessionDate: "Saturday 12 September",
  startTime: "7:00 PM",
  endTime: "9:00 PM",
  venue: "Peckham Sports Centre",
  totalCapacity: 24,
  menCapacity: 12,
  womenCapacity: 12,
  pricePerSpace: 8
};

const players = new Map();
const bookings = new Map();
const bookingStates = new Map();
const processedSquareEvents = new Set();

// ============================================================
// SUPABASE REQUEST HELPER
// ============================================================

async function supabaseRequest(
  table,
  method = "GET",
  query = "",
  body = null
) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    throw new Error(
      "SUPABASE_URL or SUPABASE_SECRET_KEY is missing."
    );
  }

  const url =
    `${SUPABASE_URL}/rest/v1/${table}${query}`;

  const options = {
    method,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization:
        `Bearer ${SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
      Prefer:
        method === "POST"
          ? "return=representation"
          : "return=representation"
    }
  };

  if (body !== null) {
    options.body = JSON.stringify(body);
  }

  const response =
    await fetch(url, options);

  const text =
    await response.text();

  let data = null;

  try {
    data = text
      ? JSON.parse(text)
      : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    console.error(
      `❌ Supabase ${table} error:`,
      data
    );

    throw new Error(
      data?.message ||
      data?.error_description ||
      `Supabase request failed: ${response.status}`
    );
  }

  return data;
}

// ============================================================
// LOAD SESSION FROM SUPABASE
// ============================================================

async function loadSession() {
  try {
    const rows =
      await supabaseRequest(
        "sessions",
        "GET",
        "?select=*&order=id.desc&limit=1"
      );

    if (
      Array.isArray(rows) &&
      rows.length > 0
    ) {
      const row = rows[0];

      badmintonSession = {
        id: row.id,

        // IMPORTANT:
        // Supabase column is session_date.
        // NEVER use a "date" column here.
        sessionDate:
          row.session_date ||
          "Saturday 12 September",

        startTime:
          row.start_time ||
          "7:00 PM",

        endTime:
          row.end_time ||
          "9:00 PM",

        venue:
          row.venue ||
          "Peckham Sports Centre",

        totalCapacity:
          Number(row.total_capacity) || 24,

        menCapacity:
          Number(row.men_capacity) || 12,

        womenCapacity:
          Number(row.women_capacity) || 12,

        pricePerSpace:
          Number(row.price_per_space) || 8
      };

      console.log(
        "✅ Session loaded from Supabase"
      );

      console.log(
        badmintonSession
      );
    } else {
      console.log(
        "ℹ️ No session found. Creating default session."
      );

      await createInitialSession();
    }
  } catch (error) {
    console.error(
      "❌ Supabase sessions error:",
      error
    );

    console.log(
      "⚠️ Using local default session."
    );
  }
}

// ============================================================
// CREATE INITIAL SESSION
// ============================================================

async function createInitialSession() {
  const row = {
    session_date:
      badmintonSession.sessionDate,

    start_time:
      badmintonSession.startTime,

    end_time:
      badmintonSession.endTime,

    venue:
      badmintonSession.venue,

    total_capacity:
      badmintonSession.totalCapacity,

    men_capacity:
      badmintonSession.menCapacity,

    women_capacity:
      badmintonSession.womenCapacity,

    price_per_space:
      badmintonSession.pricePerSpace
  };

  const result =
    await supabaseRequest(
      "sessions",
      "POST",
      "",
      row
    );

  if (
    Array.isArray(result) &&
    result.length > 0
  ) {
    badmintonSession.id =
      result[0].id;
  }

  console.log(
    "✅ Initial session created"
  );
}

// ============================================================
// SAVE SESSION
// ============================================================

async function saveSession() {
  const row = {
    session_date:
      badmintonSession.sessionDate,

    start_time:
      badmintonSession.startTime,

    end_time:
      badmintonSession.endTime,

    venue:
      badmintonSession.venue,

    total_capacity:
      Number(badmintonSession.totalCapacity),

    men_capacity:
      Number(badmintonSession.menCapacity),

    women_capacity:
      Number(badmintonSession.womenCapacity),

    price_per_space:
      Number(badmintonSession.pricePerSpace)
  };

  try {
    if (badmintonSession.id) {
      await supabaseRequest(
        "sessions",
        "PATCH",
        `?id=eq.${encodeURIComponent(
          badmintonSession.id
        )}`,
        row
      );
    } else {
      const result =
        await supabaseRequest(
          "sessions",
          "POST",
          "",
          row
        );

      if (
        Array.isArray(result) &&
        result.length > 0
      ) {
        badmintonSession.id =
          result[0].id;
      }
    }

    console.log(
      "✅ Session saved to Supabase"
    );
  } catch (error) {
    console.error(
      "❌ Admin session update failed:",
      error
    );

    throw error;
  }
}

// ============================================================
// LOAD BOOKINGS
// ============================================================

async function loadBookings() {
  try {
    const rows =
      await supabaseRequest(
        "bookings",
        "GET",
        "?select=*&order=created_at.desc"
      );

    bookings.clear();

    if (Array.isArray(rows)) {
      for (const row of rows) {
        bookings.set(
          row.phone,
          {
            id: row.id,
            status:
              row.status || "pending",

            phone:
              row.phone,

            gender:
              row.gender,

            quantity:
              Number(row.quantity) || 0,

            attendeeNames:
              Array.isArray(row.attendee_names)
                ? row.attendee_names
                : [],

            amount:
              Number(row.amount) || 0,

            squarePaymentLink:
              row.square_payment_link,

            squarePaymentLinkId:
              row.square_payment_link_id,

            squareOrderId:
              row.square_order_id,

            squarePaymentId:
              row.square_payment_id,

            paymentStatus:
              row.payment_status,

            createdAt:
              row.created_at,

            paidAt:
              row.paid_at
          }
        );
      }
    }

    console.log(
      `✅ ${bookings.size} bookings loaded`
    );
  } catch (error) {
    console.error(
      "❌ Could not load bookings:",
      error
    );
  }
}

// ============================================================
// LOAD CUSTOMERS
// ============================================================

async function loadCustomers() {
  try {
    const rows =
      await supabaseRequest(
        "customers",
        "GET",
        "?select=*"
      );

    players.clear();

    if (Array.isArray(rows)) {
      for (const row of rows) {
        players.set(
          row.phone,
          {
            id: row.id,
            name:
              row.name || "",

            points:
              Number(row.points) || 0,

            paid:
              row.paid === true,

            paymentStatus:
              row.payment_status
          }
        );
      }
    }

    console.log(
      `✅ ${players.size} customers loaded`
    );
  } catch (error) {
    console.error(
      "❌ Could not load customers:",
      error
    );
  }
}

// ============================================================
// SAVE CUSTOMER
// ============================================================

async function saveCustomer(
  phone,
  name,
  paid = false
) {
  try {
    const existing =
      players.get(phone);

    const row = {
      phone,
      name,
      points:
        existing?.points || 0,
      paid,
      payment_status:
        paid
          ? "COMPLETED"
          : "PENDING"
    };

    const result =
      await supabaseRequest(
        "customers",
        "POST",
        "",
        row
      );

    if (
      Array.isArray(result) &&
      result.length > 0
    ) {
      players.set(
        phone,
        {
          id: result[0].id,
          name,
          points:
            existing?.points || 0,
          paid,
          paymentStatus:
            paid
              ? "COMPLETED"
              : "PENDING"
        }
      );
    }
  } catch (error) {
    // If phone is unique and already exists,
    // update instead.
    try {
      await supabaseRequest(
        "customers",
        "PATCH",
        `?phone=eq.${encodeURIComponent(
          phone
        )}`,
        {
          name,
          paid,
          payment_status:
            paid
              ? "COMPLETED"
              : "PENDING"
        }
      );

      const existing =
        players.get(phone);

      players.set(
        phone,
        {
          ...existing,
          name,
          paid,
          paymentStatus:
            paid
              ? "COMPLETED"
              : "PENDING"
        }
      );
    } catch (updateError) {
      console.error(
        "❌ Customer save failed:",
        updateError
      );
    }
  }
}

// ============================================================
// SAVE BOOKING
// ============================================================

async function saveBooking(
  phone,
  booking
) {
  const row = {
    phone,
    gender:
      booking.gender,

    quantity:
      booking.quantity,

    status:
      booking.status,

    attendee_names:
      booking.attendeeNames,

    amount:
      booking.amount,

    square_payment_link:
      booking.squarePaymentLink || null,

    square_payment_link_id:
      booking.squarePaymentLinkId || null,

    square_order_id:
      booking.squareOrderId || null,

    square_payment_id:
      booking.squarePaymentId || null,

    payment_status:
      booking.paymentStatus || null,

    created_at:
      booking.createdAt ||
      new Date().toISOString(),

    paid_at:
      booking.paidAt || null
  };

  try {
    if (booking.id) {
      await supabaseRequest(
        "bookings",
        "PATCH",
        `?id=eq.${encodeURIComponent(
          booking.id
        )}`,
        row
      );
    } else {
      const result =
        await supabaseRequest(
          "bookings",
          "POST",
          "",
          row
        );

      if (
        Array.isArray(result) &&
        result.length > 0
      ) {
        booking.id =
          result[0].id;
      }
    }

    bookings.set(
      phone,
      booking
    );
  } catch (error) {
    console.error(
      "❌ Booking save failed:",
      error
    );

    throw error;
  }
}

// ============================================================
// SAVE ATTENDEES
// ============================================================

async function saveAttendees(
  bookingId,
  phone,
  gender,
  attendeeNames
) {
  if (!bookingId) {
    return;
  }

  try {
    for (
      const name of attendeeNames
    ) {
      await supabaseRequest(
        "attendees",
        "POST",
        "",
        {
          name,
          phone,
          gender,
          booking_id:
            bookingId
        }
      );
    }

    console.log(
      "✅ Attendees saved"
    );
  } catch (error) {
    console.error(
      "❌ Attendee save failed:",
      error
    );
  }
}

// ============================================================
// SQUARE WEBHOOK
// ============================================================

app.post(
  "/square/webhook",
  express.raw({
    type: "application/json"
  }),
  async (req, res) => {
    try {
      const rawBody =
        req.body.toString("utf8");

      const signature =
        req.headers[
          "x-square-hmacsha256-signature"
        ];

      const notificationUrl =
        `${BASE_URL}/square/webhook`;

      if (
        SQUARE_WEBHOOK_SIGNATURE_KEY &&
        signature
      ) {
        const valid =
          verifySquareWebhookSignature(
            rawBody,
            signature,
            notificationUrl,
            SQUARE_WEBHOOK_SIGNATURE_KEY
          );

        if (!valid) {
          console.error(
            "❌ Invalid Square webhook signature"
          );

          return res.sendStatus(403);
        }
      }

      const event =
        JSON.parse(rawBody);

      console.log(
        `💳 Square event received: ${event.type}`
      );

      if (
        event.event_id &&
        processedSquareEvents.has(
          event.event_id
        )
      ) {
        return res.sendStatus(200);
      }

      if (
        event.type ===
        "payment.updated"
      ) {
        await handleSquarePaymentUpdated(
          event
        );
      }

      if (event.event_id) {
        processedSquareEvents.add(
          event.event_id
        );
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error(
        "❌ Square webhook error:",
        error
      );

      return res.sendStatus(500);
    }
  }
);

// ============================================================
// NORMAL JSON PARSER
// ============================================================

app.use(express.json());

// ============================================================
// PRIVACY POLICY
// ============================================================

app.get(
  "/privacy-policy",
  (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
<title>Privacy Policy - Badminton Bot</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body {
  font-family: Arial, sans-serif;
  max-width: 800px;
  margin: 40px auto;
  padding: 20px;
  line-height: 1.6;
  color: #222;
}
</style>
</head>
<body>

<h1>Privacy Policy</h1>

<p>
<strong>Badminton Bot</strong> is a WhatsApp-based service
designed to help users organise and manage badminton activities.
</p>

<h2>Information We Collect</h2>

<p>
We may process information you voluntarily provide,
including your WhatsApp phone number, name, messages
and badminton booking information.
</p>

<h2>How We Use Your Information</h2>

<p>
We use this information to provide and operate the
badminton booking service.
</p>

<h2>Sharing of Information</h2>

<p>
We do not sell your personal information.
Information may be processed by service providers
necessary to operate the service, including WhatsApp/Meta,
Square, Supabase and hosting providers.
</p>

<h2>Your Rights</h2>

<p>
You may request access to or deletion of personal
information associated with your use of the bot.
</p>

<h2>Contact</h2>

<p>
hassan307@hotmail.co.uk
</p>

<p>
<strong>Last updated:</strong> 8 September 2026
</p>

</body>
</html>
`);
  }
);

// ============================================================
// HOME
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.status(200).send(
      "🏸 Badminton Bot is running!"
    );
  }
);

// ============================================================
// PAYMENT SUCCESS
// ============================================================

app.get(
  "/payment-success",
  (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payment Successful</title>
</head>
<body style="font-family:Arial;text-align:center;padding:50px">

<h1>✅ Payment successful</h1>

<p>Your payment has been received.</p>

<p>
Your booking confirmation will be sent to you on WhatsApp.
</p>

</body>
</html>
`);
  }
);

// ============================================================
// PAYMENT CANCELLED
// ============================================================

app.get(
  "/payment-cancelled",
  (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payment Cancelled</title>
</head>
<body style="font-family:Arial;text-align:center;padding:50px">

<h1>❌ Payment cancelled</h1>

<p>Your payment was cancelled.</p>

<p>Your spaces have not been confirmed.</p>

<p>Return to WhatsApp to try again.</p>

</body>
</html>
`);
  }
);

// ============================================================
// ADMIN AUTH
// ============================================================

function adminAuthenticated(
  req,
  res,
  next
) {
  const auth =
    req.headers.authorization;

  if (!auth) {
    res.setHeader(
      "WWW-Authenticate",
      'Basic realm="Badminton Admin"'
    );

    return res.status(401).send(
      "Authentication required."
    );
  }

  const encoded =
    auth.split(" ")[1];

  if (!encoded) {
    return res.status(401).send(
      "Authentication required."
    );
  }

  const decoded =
    Buffer.from(
      encoded,
      "base64"
    ).toString("utf8");

  const separator =
    decoded.indexOf(":");

  const password =
    separator >= 0
      ? decoded.slice(separator + 1)
      : "";

  if (
    ADMIN_PASSWORD &&
    password === ADMIN_PASSWORD
  ) {
    return next();
  }

  return res.status(401).send(
    "Invalid password."
  );
}

// ============================================================
// ADMIN DASHBOARD
// ============================================================

app.get(
  "/admin",
  adminAuthenticated,
  (req, res) => {
    const menRemaining =
      getRemainingSpaces("men");

    const womenRemaining =
      getRemainingSpaces("women");

    const totalRemaining =
      menRemaining +
      womenRemaining;

    const paidBookings =
      [...bookings.values()]
        .filter(
          booking =>
            booking.status === "paid"
        );

    const bookedSpaces =
      paidBookings.reduce(
        (total, booking) =>
          total +
          Number(
            booking.quantity
          ),
        0
      );

    const revenue =
      paidBookings.reduce(
        (total, booking) =>
          total +
          Number(
            booking.amount
          ),
        0
      );

    const bookingRows =
      paidBookings
        .map(
          booking => `
<tr>
<td>${escapeHtml(
            booking.phone
          )}</td>
<td>${escapeHtml(
            capitalize(
              booking.gender
            )
          )}</td>
<td>${booking.quantity}</td>
<td>
${booking.attendeeNames
  .map(
    name =>
      escapeHtml(name)
  )
  .join("<br>")}
</td>
<td>£${Number(
            booking.amount
          ).toFixed(2)}</td>
<td>Paid ✅</td>
</tr>
`
        )
        .join("");

    res.send(`
<!DOCTYPE html>
<html>
<head>

<meta name="viewport"
content="width=device-width, initial-scale=1">

<title>Badminton Admin</title>

<style>

body {
  font-family: Arial, sans-serif;
  background: #f5f5f5;
  margin: 0;
  padding: 25px;
  color: #222;
}

.container {
  max-width: 1200px;
  margin: auto;
}

h1 {
  margin-bottom: 25px;
}

.cards {
  display: grid;
  grid-template-columns:
  repeat(auto-fit,minmax(170px,1fr));
  gap: 15px;
  margin-bottom: 25px;
}

.card {
  background: white;
  border-radius: 10px;
  padding: 20px;
  box-shadow:
  0 2px 8px rgba(0,0,0,.08);
}

.card h3 {
  margin-top: 0;
  font-size: 14px;
  color: #666;
}

.card strong {
  font-size: 28px;
}

.panel {
  background: white;
  border-radius: 10px;
  padding: 25px;
  margin-bottom: 25px;
  box-shadow:
  0 2px 8px rgba(0,0,0,.08);
}

.grid {
  display: grid;
  grid-template-columns:
  repeat(auto-fit,minmax(220px,1fr));
  gap: 15px;
}

label {
  font-weight: bold;
  display: block;
  margin-bottom: 6px;
}

input {
  width: 100%;
  box-sizing: border-box;
  padding: 11px;
  border: 1px solid #ccc;
  border-radius: 6px;
  font-size: 15px;
}

input:disabled {
  background: #eee;
}

button {
  margin-top: 20px;
  padding: 12px 20px;
  border: 0;
  border-radius: 6px;
  background: #111;
  color: white;
  font-size: 15px;
  cursor: pointer;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th, td {
  text-align: left;
  padding: 12px;
  border-bottom: 1px solid #eee;
}

.table-wrap {
  overflow-x: auto;
}

.message {
  margin-top: 15px;
  font-weight: bold;
}

</style>

</head>

<body>

<div class="container">

<h1>🏸 Badminton Admin</h1>

<div class="cards">

<div class="card">
<h3>Total Spaces Remaining</h3>
<strong>${totalRemaining}</strong>
</div>

<div class="card">
<h3>Total Spaces Booked</h3>
<strong>${bookedSpaces}</strong>
</div>

<div class="card">
<h3>Men's Spaces</h3>
<strong>${menRemaining}</strong>
</div>

<div class="card">
<h3>Women's Spaces</h3>
<strong>${womenRemaining}</strong>
</div>

<div class="card">
<h3>Revenue Received</h3>
<strong>£${revenue.toFixed(2)}</strong>
</div>

</div>

<div class="panel">

<h2>⚙️ Session Details</h2>

<form
method="POST"
action="/admin/session"
>

<div class="grid">

<div>
<label>Date</label>
<input
type="text"
name="sessionDate"
value="${escapeHtml(
      badmintonSession.sessionDate
    )}"
required>
</div>

<div>
<label>Start Time</label>
<input
type="text"
name="startTime"
value="${escapeHtml(
      badmintonSession.startTime
    )}"
required>
</div>

<div>
<label>End Time</label>
<input
type="text"
name="endTime"
value="${escapeHtml(
      badmintonSession.endTime
    )}"
required>
</div>

<div>
<label>Venue</label>
<input
type="text"
name="venue"
value="${escapeHtml(
      badmintonSession.venue
    )}"
required>
</div>

<div>
<label>Price Per Space (£)</label>
<input
type="number"
step="0.01"
min="0"
name="pricePerSpace"
value="${badmintonSession.pricePerSpace}"
required>
</div>

<div>
<label>Men's Capacity</label>
<input
type="number"
min="0"
name="menCapacity"
value="${badmintonSession.menCapacity}"
required>
</div>

<div>
<label>Women's Capacity</label>
<input
type="number"
min="0"
name="womenCapacity"
value="${badmintonSession.womenCapacity}"
required>
</div>

<div>
<label>Total Capacity</label>
<input
type="number"
value="${
      Number(
        badmintonSession.menCapacity
      ) +
      Number(
        badmintonSession.womenCapacity
      )
    }"
disabled>
</div>

</div>

<button type="submit">
Save Changes
</button>

</form>

${
  req.query.saved
    ? `<div class="message">
        ✅ Session details saved successfully.
       </div>`
    : ""
}

${
  req.query.error
    ? `<div class="message">
        ❌ ${escapeHtml(
          req.query.error
        )}
       </div>`
    : ""
}

</div>

<div class="panel">

<h2>📅 Current Session</h2>

<p>
<strong>Date:</strong>
${escapeHtml(
  badmintonSession.sessionDate
)}
</p>

<p>
<strong>Time:</strong>
${escapeHtml(
  badmintonSession.startTime
)}
-
${escapeHtml(
  badmintonSession.endTime
)}
</p>

<p>
<strong>Venue:</strong>
${escapeHtml(
  badmintonSession.venue
)}
</p>

<p>
<strong>Price:</strong>
£${Number(
  badmintonSession.pricePerSpace
).toFixed(2)}
</p>

</div>

<div class="panel">

<h2>🎟️ Paid Bookings</h2>

<div class="table-wrap">

<table>

<thead>

<tr>
<th>WhatsApp</th>
<th>Category</th>
<th>Spaces</th>
<th>Attendees</th>
<th>Amount</th>
<th>Status</th>
</tr>

</thead>

<tbody>

${
  bookingRows ||
  `<tr>
    <td colspan="6">
      No paid bookings yet.
    </td>
  </tr>`
}

</tbody>

</table>

</div>

</div>

</div>

</body>
</html>
`);
  }
);

// ============================================================
// ADMIN SESSION UPDATE
// ============================================================

app.post(
  "/admin/session",
  adminAuthenticated,
  async (req, res) => {
    try {
      const {
        sessionDate,
        startTime,
        endTime,
        venue,
        pricePerSpace,
        menCapacity,
        womenCapacity
      } = req.body;

      const men =
        Number(menCapacity);

      const women =
        Number(womenCapacity);

      const price =
        Number(pricePerSpace);

      if (
        !sessionDate ||
        !startTime ||
        !endTime ||
        !venue ||
        !Number.isFinite(price) ||
        !Number.isFinite(men) ||
        !Number.isFinite(women)
      ) {
        throw new Error(
          "Please complete all session fields."
        );
      }

      if (
        price < 0 ||
        men < 0 ||
        women < 0
      ) {
        throw new Error(
          "Capacity and price cannot be negative."
        );
      }

      badmintonSession.sessionDate =
        sessionDate.trim();

      badmintonSession.startTime =
        startTime.trim();

      badmintonSession.endTime =
        endTime.trim();

      badmintonSession.venue =
        venue.trim();

      badmintonSession.pricePerSpace =
        price;

      badmintonSession.menCapacity =
        men;

      badmintonSession.womenCapacity =
        women;

      badmintonSession.totalCapacity =
        men + women;

      await saveSession();

      console.log(
        "✅ Admin session update completed"
      );

      return res.redirect(
        "/admin?saved=1"
      );
    } catch (error) {
      console.error(
        "❌ Admin session update failed:",
        error
      );

      return res.redirect(
        `/admin?error=${encodeURIComponent(
          error.message
        )}`
      );
    }
  }
);

// ============================================================
// META WEBHOOK VERIFICATION
// ============================================================

app.get(
  "/webhook",
  (req, res) => {
    const mode =
      req.query[
        "hub.mode"
      ];

    const token =
      req.query[
        "hub.verify_token"
      ];

    const challenge =
      req.query[
        "hub.challenge"
      ];

    if (
      mode === "subscribe" &&
      token === VERIFY_TOKEN
    ) {
      console.log(
        "✅ WhatsApp webhook verified"
      );

      return res
        .status(200)
        .send(challenge);
    }

    console.log(
      "❌ WhatsApp webhook verification failed"
    );

    return res.sendStatus(403);
  }
);

// ============================================================
// WHATSAPP WEBHOOK
// ============================================================

app.post(
  "/webhook",
  async (req, res) => {
    res.sendStatus(200);

    try {
      const value =
        req.body
          ?.entry?.[0]
          ?.changes?.[0]
          ?.value;

      const message =
        value?.messages?.[0];

      if (!message) {
        return;
      }

      const from =
        message.from;

      const text =
        message?.text?.body?.trim() ||
        "";

      if (!text) {
        return;
      }

      console.log(
        `📩 Message from ${from}: ${text}`
      );

      const reply =
        await handleMessage(
          from,
          text
        );

      if (reply) {
        await sendWhatsAppMessage(
          from,
          reply
        );
      }
    } catch (error) {
      console.error(
        "❌ WhatsApp webhook error:",
        error
      );
    }
  }
);

// ============================================================
// MAIN MESSAGE HANDLER
// ============================================================

async function handleMessage(
  phone,
  text
) {
  const command =
    text.toLowerCase().trim();

  const state =
    bookingStates.get(phone);

  if (
    command === "cancel" ||
    command === "menu"
  ) {
    bookingStates.delete(phone);

    return getMainMenu();
  }

  if (
    command === "hi" ||
    command === "hello" ||
    command === "start"
  ) {
    bookingStates.delete(phone);

    return getMainMenu();
  }

  if (state) {
    return handleBookingFlow(
      phone,
      text,
      state
    );
  }

  if (
    command === "1" ||
    command === "book" ||
    command === "booking"
  ) {
    bookingStates.set(
      phone,
      {
        step:
          "confirm_session"
      }
    );

    return (
      "🏸 *Book a Space*\n\n" +

      `📅 ${badmintonSession.sessionDate}\n` +

      `🕖 ${badmintonSession.startTime} - ${badmintonSession.endTime}\n` +

      `📍 ${badmintonSession.venue}\n\n` +

      `💷 £${badmintonSession.pricePerSpace} per space\n\n` +

      "Would you like to book a space for this session?\n\n" +

      "Reply *YES* to continue.\n" +

      "Reply *NO* to go back."
    );
  }

  if (
    command === "2" ||
    command === "spaces" ||
    command === "space" ||
    command === "availability"
  ) {
    return getAvailabilityMessage();
  }

  if (
    command === "3" ||
    command === "my booking"
  ) {
    return getMyBooking(phone);
  }

  if (
    command === "4" ||
    command === "my details" ||
    command === "details"
  ) {
    const player =
      players.get(phone);

    if (!player) {
      return (
        "👤 *Your Details*\n\n" +
        "I don't have your details yet."
      );
    }

    return (
      "👤 *Your Details*\n\n" +
      `Name: ${player.name}\n` +
      `Points: ${player.points || 0}\n` +
      `Payment: ${
        player.paid
          ? "Paid ✅"
          : "Not paid ❌"
      }`
    );
  }

  if (
    command === "5" ||
    command === "ranking" ||
    command === "rankings"
  ) {
    return getRanking();
  }

  if (
    isValidFullName(text)
  ) {
    const existing =
      players.get(phone);

    players.set(
      phone,
      {
        name:
          text.trim(),

        points:
          existing?.points || 0,

        paid:
          existing?.paid || false
      }
    );

    await saveCustomer(
      phone,
      text.trim(),
      existing?.paid || false
    );

    return (
      `Thanks, ${text.trim()}! 👋\n\n` +
      "I've saved your player details.\n\n" +
      "Reply *menu* to see what I can do."
    );
  }

  return (
    "🏸 I didn't understand that.\n\n" +
    "Reply *menu* to see what I can do."
  );
}

// ============================================================
// MAIN MENU
// ============================================================

function getMainMenu() {
  return (
    "🏸 *Badminton Bot*\n\n" +

    "What would you like to do?\n\n" +

    "1️⃣ *Book a space*\n" +
    "2️⃣ *Check availability*\n" +
    "3️⃣ *My booking*\n" +
    "4️⃣ *My details*\n" +
    "5️⃣ *Rankings*\n\n" +

    "Reply with the number or option."
  );
}

// ============================================================
// BOOKING FLOW
// ============================================================

async function handleBookingFlow(
  phone,
  text,
  state
) {
  const command =
    text.toLowerCase().trim();

  // ----------------------------------------------------------
  // CONFIRM SESSION
  // ----------------------------------------------------------

  if (
    state.step ===
    "confirm_session"
  ) {
    if (
      command === "no" ||
      command === "n"
    ) {
      bookingStates.delete(phone);

      return getMainMenu();
    }

    if (
      command !== "yes" &&
      command !== "y"
    ) {
      return (
        "Please reply *YES* to continue " +
        "or *NO* to go back."
      );
    }

    bookingStates.set(
      phone,
      {
        step:
          "choose_gender"
      }
    );

    return getGenderSelection();
  }

  // ----------------------------------------------------------
  // CHOOSE GENDER
  // ----------------------------------------------------------

  if (
    state.step ===
    "choose_gender"
  ) {
    let gender = null;

    if (
      command === "men" ||
      command === "man" ||
      command === "male" ||
      command === "m" ||
      command === "1"
    ) {
      gender = "men";
    }

    if (
      command === "women" ||
      command === "woman" ||
      command === "female" ||
      command === "w" ||
      command === "2"
    ) {
      gender = "women";
    }

    if (!gender) {
      return (
        "Please choose a category:\n\n" +
        "1️⃣ *Men*\n" +
        "2️⃣ *Women*\n\n" +
        "Reply *1* or *2*."
      );
    }

    const available =
      getRemainingSpaces(
        gender
      );

    if (
      available <= 0
    ) {
      return (
        `❌ There are currently no ${gender}'s spaces available.\n\n` +
        "Reply *menu* to return."
      );
    }

    bookingStates.set(
      phone,
      {
        step:
          "choose_quantity",

        gender
      }
    );

    return (
      `🏸 *${capitalize(gender)}'s spaces*\n\n` +

      `There are *${available}* spaces available.\n\n` +

      "How many spaces would you like to book?\n\n" +

      "1️⃣ *1 space*\n" +
      "2️⃣ *2 spaces*\n" +
      "3️⃣ *3 spaces*\n\n" +

      "Maximum 3 spaces per booking."
    );
  }

  // ----------------------------------------------------------
  // QUANTITY
  // ----------------------------------------------------------

  if (
    state.step ===
    "choose_quantity"
  ) {
    const quantity =
      Number(command);

    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 3
    ) {
      return (
        "Please choose *1*, *2* or *3* spaces."
      );
    }

    const available =
      getRemainingSpaces(
        state.gender
      );

    if (
      quantity > available
    ) {
      return (
        `❌ There are only *${available}* ${state.gender}'s spaces remaining.`
      );
    }

    bookingStates.set(
      phone,
      {
        step:
          "collect_names",

        gender:
          state.gender,

        quantity,

        attendeeNames: [],

        currentAttendee: 1
      }
    );

    return (
      "👤 *Attendee 1*\n\n" +
      "Please enter the *full name* of the first attendee."
    );
  }

  // ----------------------------------------------------------
  // COLLECT NAMES
  // ----------------------------------------------------------

  if (
    state.step ===
    "collect_names"
  ) {
    if (
      !isValidFullName(text)
    ) {
      return (
        "Please enter the attendee's *full name*.\n\n" +
        "Example:\n" +
        "*John Smith*"
      );
    }

    state.attendeeNames.push(
      text.trim()
    );

    if (
      state.attendeeNames.length <
      state.quantity
    ) {
      state.currentAttendee =
        state.attendeeNames.length +
        1;

      bookingStates.set(
        phone,
        state
      );

      return (
        `👤 *Attendee ${state.currentAttendee}*\n\n` +
        "Please enter the *full name*."
      );
    }

    bookingStates.set(
      phone,
      {
        step:
          "confirm_booking",

        gender:
          state.gender,

        quantity:
          state.quantity,

        attendeeNames:
          state.attendeeNames
      }
    );

    return getBookingConfirmation(
      state.gender,
      state.quantity,
      state.attendeeNames
    );
  }

  // ----------------------------------------------------------
  // CONFIRM BOOKING
  // ----------------------------------------------------------

  if (
    state.step ===
    "confirm_booking"
  ) {
    if (
      command === "no" ||
      command === "n"
    ) {
      bookingStates.delete(phone);

      return (
        "❌ Booking cancelled.\n\n" +
        getMainMenu()
      );
    }

    if (
      command !== "yes" &&
      command !== "y"
    ) {
      return (
        "Please reply *YES* to continue to payment " +
        "or *NO* to cancel."
      );
    }

    const available =
      getRemainingSpaces(
        state.gender
      );

    if (
      state.quantity > available
    ) {
      bookingStates.delete(phone);

      return (
        "❌ Sorry, those spaces have just been taken.\n\n" +
        getAvailabilityMessage()
      );
    }

    try {
      const paymentLink =
        await createSquarePaymentLink(
          phone,
          state.gender,
          state.quantity,
          state.attendeeNames
        );

      const booking = {
        status:
          "pending",

        phone,

        gender:
          state.gender,

        quantity:
          state.quantity,

        attendeeNames:
          state.attendeeNames,

        amount:
          state.quantity *
          badmintonSession.pricePerSpace,

        squarePaymentLink:
          paymentLink.url,

        squarePaymentLinkId:
          paymentLink.id,

        squareOrderId:
          paymentLink.orderId,

        paymentStatus:
          "PENDING",

        createdAt:
          new Date().toISOString()
      };

      await saveBooking(
        phone,
        booking
      );

      bookingStates.delete(phone);

      return (
        "💳 *Payment required*\n\n" +

        `Amount: *£${
          state.quantity *
          badmintonSession.pricePerSpace
        }*\n\n` +

        "Click the secure Square payment link below " +
        "to complete your booking:\n\n" +

        paymentLink.url +

        "\n\n" +

        "⚠️ Your booking is only confirmed once Square confirms your payment."
      );
    } catch (error) {
      console.error(
        "❌ Square payment link error:",
        error
      );

      return (
        "❌ Sorry, I couldn't create the payment link.\n\n" +
        "Please try again in a moment."
      );
    }
  }

  return (
    "🏸 Something went wrong.\n\n" +
    "Reply *menu* to start again."
  );
}

// ============================================================
// GENDER SELECTION
// ============================================================

function getGenderSelection() {
  const menSpaces =
    getRemainingSpaces("men");

  const womenSpaces =
    getRemainingSpaces("women");

  return (
    "🏸 *Choose your category*\n\n" +

    `1️⃣ *Men* — ${menSpaces} spaces available\n` +

    `2️⃣ *Women* — ${womenSpaces} spaces available\n\n` +

    "Reply *1* for Men or *2* for Women."
  );
}

// ============================================================
// BOOKING CONFIRMATION
// ============================================================

function getBookingConfirmation(
  gender,
  quantity,
  attendeeNames
) {
  const total =
    quantity *
    badmintonSession.pricePerSpace;

  const names =
    attendeeNames
      .map(
        (name, index) =>
          `${index + 1}. ${name}`
      )
      .join("\n");

  return (
    "🏸 *Booking Confirmation*\n\n" +

    `📅 ${badmintonSession.sessionDate}\n` +

    `🕖 ${badmintonSession.startTime} - ${badmintonSession.endTime}\n` +

    `📍 ${badmintonSession.venue}\n\n` +

    `👥 Category: ${capitalize(gender)}\n` +

    `🎟️ Spaces: ${quantity}\n\n` +

    "*Attendees:*\n" +

    names +

    "\n\n" +

    `💷 Total: *£${total}*\n\n` +

    "Is everything correct?\n\n" +

    "Reply *YES* to continue to payment.\n" +

    "Reply *NO* to cancel."
  );
}

// ============================================================
// CREATE SQUARE PAYMENT LINK
// ============================================================

async function createSquarePaymentLink(
  phone,
  gender,
  quantity,
  attendeeNames
) {
  if (
    !SQUARE_ACCESS_TOKEN
  ) {
    throw new Error(
      "SQUARE_ACCESS_TOKEN is missing."
    );
  }

  if (
    !SQUARE_LOCATION_ID
  ) {
    throw new Error(
      "SQUARE_LOCATION_ID is missing."
    );
  }

  const totalAmount =
    quantity *
    badmintonSession.pricePerSpace *
    100;

  const attendeeText =
    attendeeNames.join(", ");

  const idempotencyKey =
    crypto.randomUUID();

  const paymentNote =
    `Badminton booking | ${phone} | ` +
    `${capitalize(gender)} | ` +
    `${quantity} spaces | ` +
    `${attendeeText}`;

  const requestBody = {
    idempotency_key:
      idempotencyKey,

    quick_pay: {
      name:
        `Badminton Session - ${quantity} space${
          quantity === 1
            ? ""
            : "s"
        }`,

      price_money: {
        amount:
          totalAmount,

        currency:
          "GBP"
      },

      location_id:
        SQUARE_LOCATION_ID
    },

    description:
      `Badminton booking for ${attendeeText}`,

    payment_note:
      paymentNote,

    checkout_options: {
      redirect_url:
        `${BASE_URL}/payment-success`
    }
  };

  const response =
    await fetch(
      `${SQUARE_API_BASE}/v2/online-checkout/payment-links`,
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${SQUARE_ACCESS_TOKEN}`,

          "Content-Type":
            "application/json",

          "Square-Version":
            "2026-08-19"
        },

        body:
          JSON.stringify(
            requestBody
          )
      }
    );

  const data =
    await response.json();

  if (!response.ok) {
    console.error(
      "❌ Square API error:",
      data
    );

    throw new Error(
      data?.errors?.[0]?.detail ||
      "Square payment link creation failed."
    );
  }

  if (
    !data.payment_link?.url
  ) {
    throw new Error(
      "Square did not return a payment link."
    );
  }

  console.log(
    "✅ Square payment link created:",
    data.payment_link.id
  );

  return {
    id:
      data.payment_link.id,

    url:
      data.payment_link.url,

    orderId:
      data.payment_link.order_id
  };
}

// ============================================================
// HANDLE SQUARE PAYMENT
// ============================================================

async function handleSquarePaymentUpdated(
  event
) {
  const payment =
    event?.data?.object?.payment;

  if (!payment) {
    return;
  }

  console.log(
    `💳 Square payment ${payment.id} status: ${payment.status}`
  );

  if (
    payment.status !==
    "COMPLETED"
  ) {
    return;
  }

  const orderId =
    payment.order_id;

  if (!orderId) {
    console.error(
      "❌ Completed payment has no order ID."
    );

    return;
  }

  let bookingPhone =
    null;

  let booking =
    null;

  for (
    const [
      phone,
      existingBooking
    ]
    of bookings.entries()
  ) {
    if (
      existingBooking.status ===
        "pending" &&
      existingBooking.squareOrderId ===
        orderId
    ) {
      bookingPhone =
        phone;

      booking =
        existingBooking;

      break;
    }
  }

  if (!booking) {
    console.log(
      `ℹ️ No pending booking found for Square order ${orderId}.`
    );

    return;
  }

  if (
    booking.status ===
    "paid"
  ) {
    return;
  }

  const available =
    getRemainingSpaces(
      booking.gender
    );

  if (
    booking.quantity >
    available
  ) {
    await sendWhatsAppMessage(
      bookingPhone,

      "⚠️ *Payment received*\n\n" +

      "Your payment was successfully received, " +
      "but unfortunately the requested spaces are no longer available.\n\n" +

      "Please contact the organiser regarding your payment."
    );

    return;
  }

  booking.status =
    "paid";

  booking.paymentStatus =
    "COMPLETED";

  booking.squarePaymentId =
    payment.id;

  booking.paidAt =
    new Date().toISOString();

  await saveBooking(
    bookingPhone,
    booking
  );

  const firstAttendee =
    booking.attendeeNames[0] ||
    "Player";

  await saveCustomer(
    bookingPhone,
    firstAttendee,
    true
  );

  await saveAttendees(
    booking.id,
    bookingPhone,
    booking.gender,
    booking.attendeeNames
  );

  const names =
    booking.attendeeNames
      .map(
        (name, index) =>
          `${index + 1}. ${name}`
      )
      .join("\n");

  await sendWhatsAppMessage(
    bookingPhone,

    "✅ *Booking Confirmed!*\n\n" +

    "Your payment has been received and " +
    "your badminton spaces are confirmed.\n\n" +

    `📅 ${badmintonSession.sessionDate}\n` +

    `🕖 ${badmintonSession.startTime} - ${badmintonSession.endTime}\n` +

    `📍 ${badmintonSession.venue}\n\n` +

    `👥 Category: ${capitalize(
      booking.gender
    )}\n` +

    `🎟️ Spaces: ${booking.quantity}\n\n` +

    "*Attendees:*\n" +

    names +

    "\n\n" +

    `💷 Paid: *£${booking.amount}*\n\n` +

    "See you on court! 🏸"
  );

  console.log(
    `✅ Booking confirmed for ${bookingPhone}`
  );
}

// ============================================================
// VERIFY SQUARE SIGNATURE
// ============================================================

function verifySquareWebhookSignature(
  rawBody,
  signature,
  notificationUrl,
  signatureKey
) {
  try {
    const payload =
      notificationUrl +
      rawBody;

    const expectedSignature =
      crypto
        .createHmac(
          "sha256",
          signatureKey
        )
        .update(
          payload,
          "utf8"
        )
        .digest("base64");

    const expectedBuffer =
      Buffer.from(
        expectedSignature
      );

    const receivedBuffer =
      Buffer.from(
        signature
      );

    if (
      expectedBuffer.length !==
      receivedBuffer.length
    ) {
      return false;
    }

    return crypto.timingSafeEqual(
      expectedBuffer,
      receivedBuffer
    );
  } catch (error) {
    console.error(
      "❌ Square signature verification error:",
      error
    );

    return false;
  }
}

// ============================================================
// AVAILABILITY
// ============================================================

function getAvailabilityMessage() {
  const menSpaces =
    getRemainingSpaces("men");

  const womenSpaces =
    getRemainingSpaces("women");

  return (
    "🏸 *Check Availability*\n\n" +

    `📅 ${badmintonSession.sessionDate}\n` +

    `🕖 ${badmintonSession.startTime} - ${badmintonSession.endTime}\n` +

    `📍 ${badmintonSession.venue}\n\n` +

    `👨 Men's spaces: *${menSpaces} available*\n` +

    `👩 Women's spaces: *${womenSpaces} available*`
  );
}

// ============================================================
// REMAINING SPACES
// ============================================================

function getRemainingSpaces(
  gender
) {
  const capacity =
    gender === "men"
      ? Number(
          badmintonSession.menCapacity
        )
      : Number(
          badmintonSession.womenCapacity
        );

  let booked = 0;

  for (
    const booking
    of bookings.values()
  ) {
    if (
      booking.status === "paid" &&
      booking.gender === gender
    ) {
      booked +=
        Number(
          booking.quantity
        ) || 0;
    }
  }

  return Math.max(
    0,
    capacity - booked
  );
}

// ============================================================
// MY BOOKING
// ============================================================

function getMyBooking(
  phone
) {
  const booking =
    bookings.get(phone);

  if (!booking) {
    return (
      "🏸 *My Booking*\n\n" +
      "You don't currently have a booking.\n\n" +
      "Reply *1* to book a space."
    );
  }

  const names =
    booking.attendeeNames
      .map(
        (name, index) =>
          `${index + 1}. ${name}`
      )
      .join("\n");

  if (
    booking.status ===
    "pending"
  ) {
    return (
      "⏳ *Booking Payment Pending*\n\n" +

      `📅 ${badmintonSession.sessionDate}\n` +

      `🕖 ${badmintonSession.startTime} - ${badmintonSession.endTime}\n\n` +

      `🎟️ Spaces: ${booking.quantity}\n\n` +

      "*Attendees:*\n" +

      names +

      "\n\n" +

      "Your payment has not yet been confirmed."
    );
  }

  return (
    "🏸 *My Booking*\n\n" +

    "Status: *CONFIRMED* ✅\n\n" +

    `📅 ${badmintonSession.sessionDate}\n` +

    `🕖 ${badmintonSession.startTime} - ${badmintonSession.endTime}\n` +

    `📍 ${badmintonSession.venue}\n\n` +

    `👥 Category: ${capitalize(
      booking.gender
    )}\n` +

    `🎟️ Spaces: ${booking.quantity}\n\n` +

    "*Attendees:*\n" +

    names +

    "\n\n" +

    `💷 Paid: *£${booking.amount}*`
  );
}

// ============================================================
// NAME VALIDATION
// ============================================================

function isValidFullName(
  text
) {
  const cleaned =
    text.trim();

  const words =
    cleaned
      .split(/\s+/)
      .filter(Boolean);

  if (
    words.length < 2 ||
    words.length > 6
  ) {
    return false;
  }

  return /^[a-zA-ZÀ-ÿ'’\- ]{2,100}$/
    .test(cleaned);
}

// ============================================================
// RANKINGS
// ============================================================

function getRanking() {
  const ranked =
    [...players.values()]
      .sort(
        (a, b) =>
          (b.points || 0) -
          (a.points || 0)
      )
      .slice(0, 10);

  if (
    ranked.length === 0
  ) {
    return (
      "🏆 No players have been added to the ranking yet."
    );
  }

  return (
    "🏆 *Player Rankings*\n\n" +

    ranked
      .map(
        (player, index) =>
          `${index + 1}. ${player.name} — ${
            player.points || 0
          } pts`
      )
      .join("\n")
  );
}

// ============================================================
// CAPITALISE
// ============================================================

function capitalize(
  text
) {
  if (!text) {
    return "";
  }

  return (
    text.charAt(0).toUpperCase() +
    text.slice(1)
  );
}

// ============================================================
// ESCAPE HTML
// ============================================================

function escapeHtml(
  value
) {
  return String(
    value ?? ""
  )
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
}

// ============================================================
// SEND WHATSAPP MESSAGE
// ============================================================

async function sendWhatsAppMessage(
  to,
  message
) {
  if (
    !WHATSAPP_TOKEN ||
    !PHONE_NUMBER_ID
  ) {
    console.log(
      "⚠️ WhatsApp credentials not configured."
    );

    return;
  }

  const url =
    `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;

  try {
    const response =
      await fetch(
        url,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${WHATSAPP_TOKEN}`,

            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              messaging_product:
                "whatsapp",

              to,

              type:
                "text",

              text: {
                body:
                  message
              }
            })
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      console.error(
        "❌ WhatsApp API error:",
        data
      );

      return;
    }

    console.log(
      "✅ WhatsApp message sent"
    );
  } catch (error) {
    console.error(
      "❌ WhatsApp send error:",
      error
    );
  }
}

// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  async () => {
    console.log(
      `🏸 Badminton Bot running on port ${PORT}`
    );

    console.log(
      "🔄 Loading Supabase data..."
    );

    await loadSession();

    await loadCustomers();

    await loadBookings();

    console.log(
      "--------------------------------"
    );

    console.log(
      `📅 Session: ${badmintonSession.sessionDate}`
    );

    console.log(
      `🕖 Time: ${badmintonSession.startTime} - ${badmintonSession.endTime}`
    );

    console.log(
      `📍 Venue: ${badmintonSession.venue}`
    );

    console.log(
      `👨 Men: ${badmintonSession.menCapacity}`
    );

    console.log(
      `👩 Women: ${badmintonSession.womenCapacity}`
    );

    console.log(
      `💷 Price: £${badmintonSession.pricePerSpace}`
    );

    console.log(
      `💳 Square: ${SQUARE_ENVIRONMENT}`
    );

    console.log(
      "--------------------------------"
    );
  }
);
