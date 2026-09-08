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

const BASE_URL = process.env.BASE_URL;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ============================================================
// SQUARE API URL
// ============================================================

const SQUARE_API_BASE =
  SQUARE_ENVIRONMENT.toLowerCase() === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";

// ============================================================
// BADMINTON SESSION
// ============================================================

const badmintonSession = {
  date: "Saturday 12 September",
  startTime: "7:00 PM",
  endTime: "9:00 PM",
  venue: "Peckham Sports Centre",

  totalCapacity: 24,

  menCapacity: 12,
  womenCapacity: 12,

  pricePerSpace: 8
};

// ============================================================
// TEMPORARY STORAGE
// ============================================================

const players = new Map();

const bookings = new Map();

const bookingStates = new Map();

const processedSquareEvents = new Set();

// ============================================================
// SQUARE WEBHOOK
// ============================================================

app.post(
  "/square/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {

    console.log("📥 Square webhook request received");

    try {

      const rawBody = req.body.toString("utf8");

      const signature =
        req.headers["x-square-hmacsha256-signature"];

      const notificationUrl =
        `${BASE_URL}/square/webhook`;

      // ------------------------------------------------------
      // VERIFY SIGNATURE
      // ------------------------------------------------------

      if (
        SQUARE_WEBHOOK_SIGNATURE_KEY &&
        signature
      ) {

        const isValid =
          verifySquareWebhookSignature(
            rawBody,
            signature,
            notificationUrl,
            SQUARE_WEBHOOK_SIGNATURE_KEY
          );

        if (!isValid) {

          console.error(
            "❌ Invalid Square webhook signature"
          );

          return res.sendStatus(403);
        }

      } else {

        console.warn(
          "⚠️ Square webhook signature validation unavailable"
        );

      }

      const event =
        JSON.parse(rawBody);

      console.log(
        `💳 Square event received: ${event.type}`
      );

      console.log(
        `🆔 Square event ID: ${event.event_id || "none"}`
      );

      // ------------------------------------------------------
      // DUPLICATE EVENT PROTECTION
      // ------------------------------------------------------

      if (
        event.event_id &&
        processedSquareEvents.has(event.event_id)
      ) {

        console.log(
          `ℹ️ Event ${event.event_id} already processed`
        );

        return res.sendStatus(200);
      }

      // ------------------------------------------------------
      // PAYMENT UPDATED
      // ------------------------------------------------------

      if (
        event.type === "payment.updated"
      ) {

        await handleSquarePaymentUpdated(event);

      }

      // ------------------------------------------------------
      // MARK EVENT PROCESSED
      // ------------------------------------------------------

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
// NORMAL JSON BODY PARSER
// ============================================================

app.use(express.json());

// ============================================================
// ADMIN AUTHENTICATION
// ============================================================

function adminAuthentication(req, res, next) {

  if (!ADMIN_PASSWORD) {

    return res.status(500).send(
      "Admin password has not been configured."
    );

  }

  const auth =
    req.headers.authorization;

  if (!auth || !auth.startsWith("Basic ")) {

    res.setHeader(
      "WWW-Authenticate",
      'Basic realm="Badminton Admin"'
    );

    return res.status(401).send(
      "Admin login required."
    );

  }

  try {

    const encoded =
      auth.split(" ")[1];

    const decoded =
      Buffer
        .from(encoded, "base64")
        .toString("utf8");

    const separator =
      decoded.indexOf(":");

    const username =
      decoded.substring(0, separator);

    const password =
      decoded.substring(separator + 1);

    if (
      username !== "admin" ||
      password !== ADMIN_PASSWORD
    ) {

      res.setHeader(
        "WWW-Authenticate",
        'Basic realm="Badminton Admin"'
      );

      return res.status(401).send(
        "Incorrect admin login."
      );

    }

    next();

  } catch (error) {

    return res.status(401).send(
      "Invalid admin login."
    );

  }
}

// ============================================================
// ADMIN DASHBOARD
// ============================================================

app.get(
  "/admin",
  adminAuthentication,
  (req, res) => {

    const menRemaining =
      getRemainingSpaces("men");

    const womenRemaining =
      getRemainingSpaces("women");

    const menBooked =
      badmintonSession.menCapacity -
      menRemaining;

    const womenBooked =
      badmintonSession.womenCapacity -
      womenRemaining;

    const totalBooked =
      menBooked +
      womenBooked;

    const totalRemaining =
      menRemaining +
      womenRemaining;

    let revenue = 0;

    for (
      const booking
      of bookings.values()
    ) {

      if (
        booking.status === "paid"
      ) {

        revenue +=
          Number(booking.amount) || 0;

      }

    }

    const bookingRows =
      [...bookings.entries()]
        .map(
          ([phone, booking]) => {

            const names =
              (booking.attendeeNames || [])
                .map(escapeHtml)
                .join("<br>");

            const statusClass =
              booking.status === "paid"
                ? "paid"
                : "pending";

            const statusText =
              booking.status === "paid"
                ? "PAID"
                : "PENDING";

            return `
              <tr>
                <td>${escapeHtml(
                  booking.attendeeNames?.[0] ||
                  "Unknown"
                )}</td>

                <td>
                  ${capitalize(
                    booking.gender || ""
                  )}
                </td>

                <td>
                  ${booking.quantity || 0}
                </td>

                <td>
                  ${names}
                </td>

                <td>
                  ${escapeHtml(phone)}
                </td>

                <td>
                  <span class="status ${statusClass}">
                    ${statusText}
                  </span>
                </td>

                <td>
                  £${Number(
                    booking.amount || 0
                  ).toFixed(2)}
                </td>

                <td>
                  ${
                    booking.createdAt
                      ? new Date(
                          booking.createdAt
                        ).toLocaleString("en-GB")
                      : "-"
                  }
                </td>
              </tr>
            `;

          }
        )
        .join("");

    const playerRows =
      [...players.entries()]
        .sort(
          (a, b) =>
            (b[1].points || 0) -
            (a[1].points || 0)
        )
        .map(
          ([phone, player], index) => {

            return `
              <tr>
                <td>
                  ${index + 1}
                </td>

                <td>
                  ${escapeHtml(
                    player.name || "Unknown"
                  )}
                </td>

                <td>
                  ${escapeHtml(phone)}
                </td>

                <td>
                  ${player.points || 0}
                </td>

                <td>
                  ${
                    player.paid
                      ? '<span class="status paid">PAID</span>'
                      : '<span class="status pending">NOT PAID</span>'
                  }
                </td>
              </tr>
            `;

          }
        )
        .join("");

    res.send(`
<!DOCTYPE html>

<html lang="en">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>Badminton Admin</title>

<style>

* {
  box-sizing: border-box;
}

body {

  margin: 0;

  font-family:
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    Arial,
    sans-serif;

  background: #f5f7fa;

  color: #17202a;

}

.header {

  background: #111827;

  color: white;

  padding: 24px 32px;

}

.header-inner {

  max-width: 1400px;

  margin: auto;

  display: flex;

  justify-content: space-between;

  align-items: center;

}

.header h1 {

  margin: 0;

  font-size: 25px;

}

.header p {

  margin: 5px 0 0;

  opacity: .7;

}

.container {

  max-width: 1400px;

  margin: 30px auto;

  padding: 0 20px;

}

.session-card {

  background: white;

  border-radius: 14px;

  padding: 25px;

  margin-bottom: 25px;

  box-shadow:
    0 2px 10px rgba(0,0,0,.05);

}

.session-card h2 {

  margin-top: 0;

}

.session-details {

  display: grid;

  grid-template-columns:
    repeat(auto-fit, minmax(180px, 1fr));

  gap: 15px;

}

.detail {

  background: #f8fafc;

  padding: 15px;

  border-radius: 10px;

}

.detail strong {

  display: block;

  margin-bottom: 5px;

}

.stats {

  display: grid;

  grid-template-columns:
    repeat(auto-fit, minmax(200px, 1fr));

  gap: 18px;

  margin-bottom: 30px;

}

.stat {

  background: white;

  border-radius: 14px;

  padding: 22px;

  box-shadow:
    0 2px 10px rgba(0,0,0,.05);

}

.stat-label {

  color: #6b7280;

  font-size: 14px;

}

.stat-number {

  font-size: 32px;

  font-weight: 700;

  margin-top: 8px;

}

.section {

  background: white;

  border-radius: 14px;

  padding: 25px;

  margin-bottom: 25px;

  box-shadow:
    0 2px 10px rgba(0,0,0,.05);

}

.section h2 {

  margin-top: 0;

}

.table-wrapper {

  overflow-x: auto;

}

table {

  width: 100%;

  border-collapse: collapse;

  min-width: 850px;

}

th {

  text-align: left;

  background: #f8fafc;

  padding: 13px;

  font-size: 13px;

  color: #4b5563;

}

td {

  padding: 14px 13px;

  border-top: 1px solid #edf0f3;

  font-size: 14px;

}

.status {

  display: inline-block;

  padding: 5px 9px;

  border-radius: 999px;

  font-size: 11px;

  font-weight: 700;

}

.status.paid {

  background: #dcfce7;

  color: #166534;

}

.status.pending {

  background: #fef3c7;

  color: #92400e;

}

.empty {

  text-align: center;

  padding: 35px;

  color: #6b7280;

}

.refresh {

  background: white;

  border: 1px solid #d1d5db;

  border-radius: 8px;

  padding: 9px 14px;

  cursor: pointer;

}

.refresh:hover {

  background: #f3f4f6;

}

@media (max-width: 600px) {

  .header {

    padding: 20px;

  }

  .container {

    padding: 0 12px;

    margin-top: 18px;

  }

  .session-card,
  .section {

    padding: 18px;

  }

}

</style>

</head>

<body>

<div class="header">

  <div class="header-inner">

    <div>

      <h1>🏸 Badminton Admin</h1>

      <p>Session management dashboard</p>

    </div>

    <button
      class="refresh"
      onclick="location.reload()"
    >
      Refresh
    </button>

  </div>

</div>

<div class="container">

  <div class="session-card">

    <h2>Current Session</h2>

    <div class="session-details">

      <div class="detail">
        <strong>📅 Date</strong>
        ${escapeHtml(badmintonSession.date)}
      </div>

      <div class="detail">
        <strong>🕖 Time</strong>
        ${escapeHtml(
          badmintonSession.startTime
        )}
        -
        ${escapeHtml(
          badmintonSession.endTime
        )}
      </div>

      <div class="detail">
        <strong>📍 Venue</strong>
        ${escapeHtml(
          badmintonSession.venue
        )}
      </div>

      <div class="detail">
        <strong>💷 Price</strong>
        £${badmintonSession.pricePerSpace}
        per space
      </div>

    </div>

  </div>

  <div class="stats">

    <div class="stat">

      <div class="stat-label">
        Total Spaces Remaining
      </div>

      <div class="stat-number">
        ${totalRemaining}
      </div>

    </div>

    <div class="stat">

      <div class="stat-label">
        Total Spaces Booked
      </div>

      <div class="stat-number">
        ${totalBooked}
      </div>

    </div>

    <div class="stat">

      <div class="stat-label">
        Men's Spaces
      </div>

      <div class="stat-number">
        ${menBooked}/${badmintonSession.menCapacity}
      </div>

    </div>

    <div class="stat">

      <div class="stat-label">
        Women's Spaces
      </div>

      <div class="stat-number">
        ${womenBooked}/${badmintonSession.womenCapacity}
      </div>

    </div>

    <div class="stat">

      <div class="stat-label">
        Revenue Received
      </div>

      <div class="stat-number">
        £${revenue.toFixed(2)}
      </div>

    </div>

  </div>

  <div class="section">

    <h2>📋 Bookings</h2>

    ${
      bookingRows
        ? `
          <div class="table-wrapper">

            <table>

              <thead>

                <tr>

                  <th>Player</th>
                  <th>Category</th>
                  <th>Spaces</th>
                  <th>Attendees</th>
                  <th>WhatsApp</th>
                  <th>Payment</th>
                  <th>Amount</th>
                  <th>Booked</th>

                </tr>

              </thead>

              <tbody>

                ${bookingRows}

              </tbody>

            </table>

          </div>
        `
        : `
          <div class="empty">
            No bookings yet.
          </div>
        `
    }

  </div>

  <div class="section">

    <h2>👤 Customers & Rankings</h2>

    ${
      playerRows
        ? `
          <div class="table-wrapper">

            <table>

              <thead>

                <tr>

                  <th>#</th>
                  <th>Name</th>
                  <th>WhatsApp</th>
                  <th>Points</th>
                  <th>Payment</th>

                </tr>

              </thead>

              <tbody>

                ${playerRows}

              </tbody>

            </table>

          </div>
        `
        : `
          <div class="empty">
            No customers yet.
          </div>
        `
    }

  </div>

</div>

</body>

</html>
    `);

  }
);

// ============================================================
// PRIVACY POLICY
// ============================================================

app.get("/privacy-policy", (req, res) => {

  res.send(`
<!DOCTYPE html>

<html>

<head>

<title>Privacy Policy - Badminton Bot</title>

<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
>

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
<strong>Badminton Bot</strong> is a WhatsApp-based
service designed to help users organise and manage
badminton activities.
</p>

<h2>Information We Collect</h2>

<p>
When you use Badminton Bot, we may process information
that you voluntarily provide, including your WhatsApp
phone number, name, messages and information relating
to your badminton activities.
</p>

<h2>How We Use Your Information</h2>

<p>
We use this information to provide, operate and improve
the Badminton Bot service.
</p>

<h2>Sharing of Information</h2>

<p>
We do not sell your personal information.
Information may be processed by service providers
necessary to operate the bot, including WhatsApp/Meta
and our hosting and software providers.
</p>

<h2>Data Retention</h2>

<p>
We retain information only for as long as reasonably
necessary to provide the service or where we have a
legitimate legal or operational reason to retain it.
</p>

<h2>Your Rights</h2>

<p>
You may request access to or deletion of personal
information associated with your use of the bot.
</p>

<h2>Contact</h2>

<p>
<strong>hassan307@hotmail.co.uk</strong>
</p>

<p>
<strong>Last updated:</strong> 8 September 2026
</p>

</body>

</html>
  `);

});

// ============================================================
// HOME
// ============================================================

app.get("/", (req, res) => {

  res.status(200).send(
    "🏸 Badminton Bot is running!"
  );

});

// ============================================================
// PAYMENT SUCCESS
// ============================================================

app.get("/payment-success", (req, res) => {

  res.send(`
<!DOCTYPE html>

<html>

<head>

<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
>

<title>Payment Successful</title>

</head>

<body
style="
font-family: Arial;
text-align: center;
padding: 50px;
"
>

<h1>✅ Payment successful</h1>

<p>
Your payment has been received.
</p>

<p>
Your booking confirmation will be sent to you
on WhatsApp.
</p>

</body>

</html>
  `);

});

// ============================================================
// PAYMENT CANCELLED
// ============================================================

app.get("/payment-cancelled", (req, res) => {

  res.send(`
<!DOCTYPE html>

<html>

<head>

<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
>

<title>Payment Cancelled</title>

</head>

<body
style="
font-family: Arial;
text-align: center;
padding: 50px;
"
>

<h1>❌ Payment cancelled</h1>

<p>
Your payment was cancelled.
</p>

<p>
Your spaces have not been booked.
</p>

</body>

</html>
  `);

});

// ============================================================
// META WEBHOOK VERIFICATION
// ============================================================

app.get("/webhook", (req, res) => {

  const mode =
    req.query["hub.mode"];

  const token =
    req.query["hub.verify_token"];

  const challenge =
    req.query["hub.challenge"];

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

  return res.sendStatus(403);

});

// ============================================================
// RECEIVE WHATSAPP MESSAGES
// ============================================================

app.post("/webhook", async (req, res) => {

  res.sendStatus(200);

  try {

    const value =
      req.body?.entry?.[0]?.changes?.[0]?.value;

    const message =
      value?.messages?.[0];

    if (!message) {
      return;
    }

    const from =
      message.from;

    const text =
      message?.text?.body?.trim() || "";

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

});

// ============================================================
// MAIN BOT LOGIC
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

    return await handleBookingFlow(
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
        step: "confirm_session"
      }
    );

    return (

      "🏸 *Book a Space*\n\n" +

      `📅 ${badmintonSession.date}\n` +

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

        "I don't have your details yet.\n\n" +

        "Please send me your full name."

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

    const existingPlayer =
      players.get(phone);

    players.set(
      phone,
      {

        name:
          text.trim(),

        points:
          existingPlayer?.points || 0,

        paid:
          existingPlayer?.paid || false

      }
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

  if (
    state.step === "confirm_session"
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
        step: "choose_gender"
      }
    );

    return getGenderSelection();

  }

  if (
    state.step === "choose_gender"
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

        "I just need to know which category you're booking for.\n\n" +

        "1️⃣ *Men*\n" +

        "2️⃣ *Women*\n\n" +

        "Reply *1* for Men or *2* for Women."

      );

    }

    const available =
      getRemainingSpaces(gender);

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

        step: "choose_quantity",

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

      "Maximum *3 spaces* per booking.\n\n" +

      "Reply with *1*, *2* or *3*."

    );

  }

  if (
    state.step === "choose_quantity"
  ) {

    const quantity =
      Number(command);

    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 3
    ) {

      return (
        "Please choose 1, 2 or 3 spaces."
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
        `❌ There are only *${available}* spaces remaining.`
      );

    }

    bookingStates.set(
      phone,
      {

        step: "collect_names",

        gender:
          state.gender,

        quantity,

        attendeeNames: [],

        currentAttendee: 1

      }
    );

    return (

      "👤 *Attendee 1*\n\n" +

      "Please enter the *full name* of the first attendee.\n\n" +

      "Example: *John Smith*"

    );

  }

  if (
    state.step === "collect_names"
  ) {

    if (
      !isValidFullName(text)
    ) {

      return (
        "Please enter the attendee's *full name*.\n\n" +
        "Example: *John Smith*"
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
        state.attendeeNames.length + 1;

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

        step: "confirm_booking",

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

  if (
    state.step === "confirm_booking"
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
        "Please reply *YES* to confirm your booking " +
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

      bookings.set(
        phone,
        {

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

          createdAt:
            new Date().toISOString()

        }
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

    "Please choose the category you are booking for:\n\n" +

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

    `📅 ${badmintonSession.date}\n` +

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

  if (!SQUARE_ACCESS_TOKEN) {
    throw new Error(
      "SQUARE_ACCESS_TOKEN is missing."
    );
  }

  if (!SQUARE_LOCATION_ID) {
    throw new Error(
      "SQUARE_LOCATION_ID is missing."
    );
  }

  const totalAmount =
    quantity *
    badmintonSession.pricePerSpace *
    100;

  const idempotencyKey =
    crypto.randomUUID();

  const attendeeText =
    attendeeNames.join(", ");

  const paymentNote =
    `Badminton booking | ` +
    `${phone} | ` +
    `${capitalize(gender)} | ` +
    `${quantity} spaces | ` +
    `${attendeeText}`;

  const requestBody = {

    idempotency_key:
      idempotencyKey,

    quick_pay: {

      name:
        `Badminton Session - ${quantity} space${
          quantity === 1 ? "" : "s"
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
          JSON.stringify(requestBody)

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

    console.log(
      "⚠️ Square webhook contained no payment."
    );

    return;

  }

  console.log(
    `💳 Square payment ${payment.id} status: ${payment.status}`
  );

  console.log(
    `📦 Square order ID: ${
      payment.order_id || "none"
    }`
  );

  if (
    payment.status !== "COMPLETED"
  ) {

    console.log(
      `ℹ️ Payment is ${payment.status}; waiting for COMPLETED.`
    );

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

  let bookingPhone = null;

  let booking = null;

  for (
    const [phone, existingBooking]
    of bookings.entries()
  ) {

    if (
      existingBooking.status === "pending" &&
      existingBooking.squareOrderId === orderId
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
      `ℹ️ No pending booking found for order ${orderId}.`
    );

    console.log(
      "Available bookings:",
      [...bookings.values()].map(
        booking => ({
          status: booking.status,
          orderId: booking.squareOrderId
        })
      )
    );

    return;

  }

  const available =
    getRemainingSpaces(
      booking.gender
    );

  if (
    booking.quantity > available
  ) {

    console.error(
      "❌ Payment received but spaces are no longer available."
    );

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

  bookings.set(
    bookingPhone,
    booking
  );

  const firstAttendee =
    booking.attendeeNames[0] ||
    "Player";

  const existingPlayer =
    players.get(
      bookingPhone
    );

  players.set(
    bookingPhone,
    {

      name:
        existingPlayer?.name ||
        firstAttendee,

      points:
        existingPlayer?.points ||
        0,

      paid:
        true,

      lastBooking:
        booking

    }
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

    `📅 ${badmintonSession.date}\n` +

    `🕖 ${badmintonSession.startTime} - ${badmintonSession.endTime}\n` +

    `📍 ${badmintonSession.venue}\n\n` +

    `👥 Category: ${capitalize(booking.gender)}\n` +

    `🎟️ Spaces: ${booking.quantity}\n\n` +

    "*Attendees:*\n" +

    names +

    "\n\n" +

    `💷 Paid: *£${booking.amount}*\n\n` +

    "See you on court! 🏸"

  );

  console.log(
    `✅ BOOKING CONFIRMED for ${bookingPhone}`
  );

}

// ============================================================
// SQUARE SIGNATURE VERIFICATION
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

    `📅 ${badmintonSession.date}\n` +

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
      ? badmintonSession.menCapacity
      : badmintonSession.womenCapacity;

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
    booking.status === "pending"
  ) {

    return (

      "⏳ *Booking Payment Pending*\n\n" +

      `📅 ${badmintonSession.date}\n` +

      `🕖 ${badmintonSession.startTime} - ${badmintonSession.endTime}\n` +

      `📍 ${badmintonSession.venue}\n\n` +

      `👥 Category: ${capitalize(booking.gender)}\n` +

      `🎟️ Spaces: ${booking.quantity}\n\n` +

      "*Attendees:*\n" +

      names +

      "\n\n" +

      `💷 Amount due: *£${booking.amount}*\n\n` +

      "Your payment has not yet been confirmed."

    );

  }

  return (

    "🏸 *My Booking*\n\n" +

    "Status: *CONFIRMED* ✅\n\n" +

    `📅 ${badmintonSession.date}\n` +

    `🕖 ${badmintonSession.startTime} - ${badmintonSession.endTime}\n` +

    `📍 ${badmintonSession.venue}\n\n` +

    `👥 Category: ${capitalize(booking.gender)}\n` +

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
      "🏆 No players have been added " +
      "to the ranking yet."
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
// HTML ESCAPING
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
      "⚠️ WhatsApp credentials are not configured."
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

          method:
            "POST",

          headers:
            {

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

              text:
                {
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
  () => {

    console.log(
      `🏸 Badminton Bot running on port ${PORT}`
    );

    console.log(
      `📅 Session: ${badmintonSession.date}`
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
      `💳 Square environment: ${SQUARE_ENVIRONMENT}`
    );

    console.log(
      `🔐 Admin dashboard: ${
        ADMIN_PASSWORD
          ? "configured"
          : "NOT CONFIGURED"
      }`);

    if (
      SQUARE_ACCESS_TOKEN &&
      SQUARE_LOCATION_ID
    ) {

      console.log(
        "✅ Square credentials detected"
      );

    } else {

      console.log(
        "⚠️ Square credentials are NOT fully configured"
      );

    }

  }
);
