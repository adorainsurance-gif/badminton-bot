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

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

// ============================================================
// API URLS
// ============================================================

const SQUARE_API_BASE =
  SQUARE_ENVIRONMENT.toLowerCase() === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";

const WHATSAPP_API_BASE =
  "https://graph.facebook.com/v23.0";

// ============================================================
// IN-MEMORY STATE
// ============================================================

// Conversation states are intentionally kept in memory.
// Bookings and session information are stored in Supabase.

const bookingStates = new Map();
const processedSquareEvents = new Set();

// Current session cache
let badmintonSession = null;

// ============================================================
// SUPABASE HELPERS
// ============================================================

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    "Content-Type": "application/json",
    ...extra
  };
}

async function supabaseRequest(
  path,
  options = {}
) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    throw new Error(
      "SUPABASE_URL or SUPABASE_SECRET_KEY is missing."
    );
  }

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: supabaseHeaders(
        options.headers || {}
      )
    }
  );

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${
        typeof data === "string"
          ? data
          : JSON.stringify(data)
      }`
    );
  }

  return data;
}

// ============================================================
// SESSION
// ============================================================

async function loadSession() {
  try {
    const rows = await supabaseRequest(
      "sessions?select=*&order=id.asc&limit=1"
    );

    if (!rows || rows.length === 0) {
      console.error(
        "❌ No session exists in Supabase."
      );

      badmintonSession = null;

      return;
    }

    const row = rows[0];

    badmintonSession = {
      id: row.id,
      date: row.session_date,
      startTime: row.start_time,
      endTime: row.end_time,
      venue: row.venue,
      pricePerSpace: Number(
        row.price_per_space
      ),
      menCapacity: Number(
        row.men_capacity
      ),
      womenCapacity: Number(
        row.women_capacity
      ),
      totalCapacity: Number(
        row.total_capacity
      )
    };

    console.log(
      "✅ Session loaded from Supabase:",
      badmintonSession
    );
  } catch (error) {
    console.error(
      "❌ Could not load session:",
      error
    );

    badmintonSession = null;
  }
}

async function saveSession(data) {
  if (!badmintonSession?.id) {
    throw new Error(
      "No session ID is loaded."
    );
  }

  const updated = {
    session_date: data.date,
    start_time: data.startTime,
    end_time: data.endTime,
    venue: data.venue,
    price_per_space: Number(
      data.pricePerSpace
    ),
    men_capacity: Number(
      data.menCapacity
    ),
    women_capacity: Number(
      data.womenCapacity
    ),
    total_capacity: Number(
      data.totalCapacity
    )
  };

  const rows = await supabaseRequest(
    `sessions?id=eq.${encodeURIComponent(
      badmintonSession.id
    )}&select=*`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify(updated)
    }
  );

  if (!rows || rows.length === 0) {
    throw new Error(
      "Supabase updated 0 session rows."
    );
  }

  const row = rows[0];

  badmintonSession = {
    id: row.id,
    date: row.session_date,
    startTime: row.start_time,
    endTime: row.end_time,
    venue: row.venue,
    pricePerSpace: Number(
      row.price_per_space
    ),
    menCapacity: Number(
      row.men_capacity
    ),
    womenCapacity: Number(
      row.women_capacity
    ),
    totalCapacity: Number(
      row.total_capacity
    )
  };

  return badmintonSession;
}

// ============================================================
// BOOKINGS
// ============================================================

async function getPaidBookings() {
  return await supabaseRequest(
    "bookings?select=*&status=eq.paid&order=created_at.asc"
  );
}

async function getAllBookings() {
  return await supabaseRequest(
    "bookings?select=*&order=created_at.desc"
  );
}

async function getPendingBookingByPhone(
  phone
) {
  const rows = await supabaseRequest(
    `bookings?phone=eq.${encodeURIComponent(
      phone
    )}&status=eq.pending&order=created_at.desc&limit=1`
  );

  return rows?.[0] || null;
}

async function getBookingByOrderId(
  orderId
) {
  const rows = await supabaseRequest(
    `bookings?square_order_id=eq.${encodeURIComponent(
      orderId
    )}&limit=1`
  );

  return rows?.[0] || null;
}

async function getRemainingSpaces(
  gender
) {
  if (!badmintonSession) {
    return 0;
  }

  const bookings =
    await getPaidBookings();

  const used = bookings
    .filter(
      booking =>
        booking.gender === gender
    )
    .reduce(
      (total, booking) =>
        total + Number(booking.quantity || 0),
      0
    );

  const capacity =
    gender === "men"
      ? badmintonSession.menCapacity
      : badmintonSession.womenCapacity;

  return Math.max(
    0,
    capacity - used
  );
}

async function getTotalRemainingSpaces() {
  const men =
    await getRemainingSpaces("men");

  const women =
    await getRemainingSpaces("women");

  return men + women;
}

// ============================================================
// CUSTOMERS
// ============================================================

async function getCustomer(phone) {
  const rows = await supabaseRequest(
    `customers?phone=eq.${encodeURIComponent(
      phone
    )}&limit=1`
  );

  return rows?.[0] || null;
}

async function saveCustomer(
  phone,
  name,
  points,
  paymentStatus = "paid"
) {
  const existing =
    await getCustomer(phone);

  const payload = {
    phone,
    name,
    points: Number(points || 0),
    paid: paymentStatus === "paid",
    payment_status: paymentStatus
  };

  if (existing) {
    await supabaseRequest(
      `customers?phone=eq.${encodeURIComponent(
        phone
      )}`,
      {
        method: "PATCH",
        headers: {
          Prefer: "return=minimal"
        },
        body: JSON.stringify(payload)
      }
    );
  } else {
    await supabaseRequest(
      "customers",
      {
        method: "POST",
        headers: {
          Prefer: "return=minimal"
        },
        body: JSON.stringify(payload)
      }
    );
  }
}

// ============================================================
// RANKINGS
// ============================================================

async function addRankingPoints(
  attendeeNames
) {
  if (!Array.isArray(attendeeNames)) {
    return;
  }

  for (const name of attendeeNames) {
    const cleanName =
      String(name || "").trim();

    if (!cleanName) {
      continue;
    }

    try {
      const rows =
        await supabaseRequest(
          `rankings?name=eq.${encodeURIComponent(
            cleanName
          )}&limit=1`
        );

      if (rows?.length) {
        const current =
          Number(rows[0].points || 0);

        await supabaseRequest(
          `rankings?id=eq.${rows[0].id}`,
          {
            method: "PATCH",
            headers: {
              Prefer: "return=minimal"
            },
            body: JSON.stringify({
              points: current + 1
            })
          }
        );
      } else {
        await supabaseRequest(
          "rankings",
          {
            method: "POST",
            headers: {
              Prefer: "return=minimal"
            },
            body: JSON.stringify({
              phone:
                `attendee-${crypto
                  .randomUUID()}`,
              name: cleanName,
              points: 1
            })
          }
        );
      }
    } catch (error) {
      console.error(
        `❌ Ranking update failed for ${cleanName}:`,
        error
      );
    }
  }
}

async function getRanking() {
  try {
    const rows =
      await supabaseRequest(
        "rankings?select=name,points&order=points.desc,name.asc"
      );

    if (!rows?.length) {
      return (
        "🏆 *Rankings*\n\n" +
        "No rankings yet."
      );
    }

    const top = rows.slice(0, 10);

    let message =
      "🏆 *Badminton Rankings*\n\n";

    top.forEach((player, index) => {
      message +=
        `${index + 1}. *${player.name}* — ${Number(
          player.points || 0
        )} point${
          Number(player.points || 0) === 1
            ? ""
            : "s"
        }\n`;
    });

    return message;
  } catch (error) {
    console.error(
      "❌ Could not load rankings:",
      error
    );

    return (
      "❌ Sorry, I couldn't load the rankings right now."
    );
  }
}

// ============================================================
// ATTENDEES
// ============================================================

async function saveAttendees(
  bookingId,
  phone,
  gender,
  names
) {
  if (!Array.isArray(names)) {
    return;
  }

  const rows = names.map(name => ({
    booking_id: bookingId,
    name: String(name).trim(),
    phone,
    gender
  }));

  if (!rows.length) {
    return;
  }

  await supabaseRequest(
    "attendees",
    {
      method: "POST",
      headers: {
        Prefer: "return=minimal"
      },
      body: JSON.stringify(rows)
    }
  );
}

// ============================================================
// WHATSAPP
// ============================================================

async function sendWhatsAppMessage(
  to,
  message
) {
  if (
    !WHATSAPP_TOKEN ||
    !PHONE_NUMBER_ID
  ) {
    console.error(
      "❌ WhatsApp credentials missing."
    );

    return;
  }

  const response = await fetch(
    `${WHATSAPP_API_BASE}/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization:
          `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type":
          "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: {
          preview_url: true,
          body: message
        }
      })
    }
  );

  if (!response.ok) {
    const error =
      await response.text();

    console.error(
      "❌ WhatsApp send failed:",
      error
    );
  }
}

// ============================================================
// SQUARE
// ============================================================

function verifySquareWebhookSignature(
  rawBody,
  signature,
  notificationUrl,
  signatureKey
) {
  const expected =
    crypto
      .createHmac(
        "sha256",
        signatureKey
      )
      .update(
        notificationUrl + rawBody
      )
      .digest("base64");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature)
    );
  } catch {
    return false;
  }
}

async function createSquarePaymentLink(
  booking
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

  const idempotencyKey =
    crypto.randomUUID();

  const response = await fetch(
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
      body: JSON.stringify({
        idempotency_key:
          idempotencyKey,

        order: {
          location_id:
            SQUARE_LOCATION_ID,

          line_items: [
            {
              name:
                `Badminton - ${booking.quantity} space${
                  booking.quantity === 1
                    ? ""
                    : "s"
                }`,

              quantity:
                String(booking.quantity),

              base_price_money: {
                amount: Math.round(
                  Number(
                    badmintonSession.pricePerSpace
                  ) * 100
                ),
                currency: "GBP"
              }
            }
          ]
        },

        checkout_options: {
          redirect_url:
            `${BASE_URL}/payment-success`
        },

        payment_note:
          `Badminton booking - ${booking.phone}`
      })
    }
  );

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      `Square ${response.status}: ${JSON.stringify(
        data
      )}`
    );
  }

  return {
    paymentLink:
      data.payment_link?.url ||
      data.payment_link?.long_url ||
      data.payment_link?.url_with_parameters,

    squareOrderId:
      data.payment_link?.order_id ||
      data.order?.id,

    squarePaymentLinkId:
      data.payment_link?.id
  };
}

// ============================================================
// HANDLE SQUARE PAYMENT
// ============================================================

async function handleSquarePaymentUpdated(
  event
) {
  const payment =
    event.data?.object?.payment;

  if (!payment) {
    console.log(
      "ℹ️ Square payment.updated had no payment object."
    );

    return;
  }

  console.log(
    `💳 Payment ${payment.id} status: ${payment.status}`
  );

  if (payment.status !== "COMPLETED") {
    return;
  }

  const orderId =
    payment.order_id;

  if (!orderId) {
    console.error(
      "❌ Completed Square payment has no order ID."
    );

    return;
  }

  const booking =
    await getBookingByOrderId(orderId);

  if (!booking) {
    console.error(
      `❌ No booking found for Square order ${orderId}`
    );

    return;
  }

  if (booking.status === "paid") {
    console.log(
      `ℹ️ Booking ${booking.id} already paid.`
    );

    return;
  }

  // ----------------------------------------------------------
  // FINAL CAPACITY CHECK
  // ----------------------------------------------------------

  const available =
    await getRemainingSpaces(
      booking.gender
    );

  if (
    available < Number(booking.quantity)
  ) {
    console.error(
      `❌ Payment received but insufficient ${booking.gender} capacity for booking ${booking.id}.`
    );

    await supabaseRequest(
      `bookings?id=eq.${booking.id}`,
      {
        method: "PATCH",
        headers: {
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          payment_status:
            "paid_capacity_error",
          square_payment_id:
            payment.id
        })
      }
    );

    await sendWhatsAppMessage(
      booking.phone,
      "⚠️ Your payment was received, but unfortunately the remaining spaces were taken before your payment was confirmed.\n\nPlease contact the organiser so your payment can be resolved."
    );

    return;
  }

  // ----------------------------------------------------------
  // MARK BOOKING PAID
  // ----------------------------------------------------------

  await supabaseRequest(
    `bookings?id=eq.${booking.id}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        status: "paid",
        payment_status: "paid",
        square_payment_id:
          payment.id,
        paid_at:
          new Date().toISOString()
      })
    }
  );

  // ----------------------------------------------------------
  // CUSTOMER
  // ----------------------------------------------------------

  const firstName =
    Array.isArray(booking.attendee_names) &&
    booking.attendee_names.length
      ? booking.attendee_names[0]
      : "Player";

  const customer =
    await getCustomer(
      booking.phone
    );

  const currentPoints =
    Number(customer?.points || 0);

  await saveCustomer(
    booking.phone,
    firstName,
    currentPoints +
      Number(booking.quantity || 0),
    "paid"
  );

  // ----------------------------------------------------------
  // RANKING
  // ----------------------------------------------------------

  await addRankingPoints(
    booking.attendee_names
  );

  // ----------------------------------------------------------
  // WHATSAPP CONFIRMATION
  // ----------------------------------------------------------

  let names = "";

  if (
    Array.isArray(booking.attendee_names)
  ) {
    names =
      booking.attendee_names
        .map(
          (name, index) =>
            `${index + 1}. ${name}`
        )
        .join("\n");
  }

  const confirmation =
    "🏸 *BOOKING CONFIRMED* ✅\n\n" +
    `📅 ${badmintonSession.date}\n` +
    `🕖 ${badmintonSession.startTime} - ${badmintonSession.endTime}\n` +
    `📍 ${badmintonSession.venue}\n\n` +
    `👥 *Attendees*\n${names}\n\n` +
    `💷 Paid: £${Number(
      booking.amount || 0
    ).toFixed(2)}\n\n` +
    "Your payment has been confirmed and your space(s) are booked.\n\n" +
    "See you on court! 🏸";

  await sendWhatsAppMessage(
    booking.phone,
    confirmation
  );

  console.log(
    `✅ Booking ${booking.id} confirmed and paid.`
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
// GENDER SELECTION
// ============================================================

function getGenderSelection() {
  return (
    "👤 *Choose your category*\n\n" +
    "1️⃣ *Men*\n" +
    "2️⃣ *Women*\n\n" +
    "Reply *1* for Men or *2* for Women."
  );
}

// ============================================================
// AVAILABILITY
// ============================================================

async function getAvailabilityMessage() {
  if (!badmintonSession) {
    return (
      "❌ Session information is currently unavailable."
    );
  }

  const men =
    await getRemainingSpaces("men");

  const women =
    await getRemainingSpaces("women");

  return (
    "🏸 *Current Availability*\n\n" +
    `📅 ${badmintonSession.date}\n` +
    `🕖 ${badmintonSession.startTime} - ${badmintonSession.endTime}\n` +
    `📍 ${badmintonSession.venue}\n\n` +
    `👨 Men: *${men} spaces available*\n` +
    `👩 Women: *${women} spaces available*\n\n` +
    `💷 £${badmintonSession.pricePerSpace} per space`
  );
}

// ============================================================
// MY BOOKING
// ============================================================

async function getMyBooking(phone) {
  try {
    const rows =
      await supabaseRequest(
        `bookings?phone=eq.${encodeURIComponent(
          phone
        )}&order=created_at.desc&limit=1`
      );

    if (!rows?.length) {
      return (
        "📋 *My Booking*\n\n" +
        "You don't currently have a booking."
      );
    }

    const booking = rows[0];

    let names = "";

    if (
      Array.isArray(
        booking.attendee_names
      )
    ) {
      names =
        booking.attendee_names
          .map(
            (name, index) =>
              `${index + 1}. ${name}`
          )
          .join("\n");
    }

    const status =
      booking.status === "paid"
        ? "Confirmed ✅"
        : "Payment pending ⏳";

    return (
      "📋 *My Booking*\n\n" +
      `Status: *${status}*\n\n` +
      `📅 ${badmintonSession.date}\n` +
      `🕖 ${badmintonSession.startTime} - ${badmintonSession.endTime}\n` +
      `📍 ${badmintonSession.venue}\n\n` +
      `👥 *Attendees*\n${names}\n\n` +
      `💷 £${Number(
        booking.amount || 0
      ).toFixed(2)}`
    );
  } catch (error) {
    console.error(
      "❌ My booking error:",
      error
    );

    return (
      "❌ Sorry, I couldn't load your booking."
    );
  }
}

// ============================================================
// FULL NAME VALIDATION
// ============================================================

function isValidFullName(name) {
  const value =
    String(name || "").trim();

  if (!value) {
    return false;
  }

  const words =
    value.split(/\s+/);

  if (
    words.length < 2 ||
    words.length > 6
  ) {
    return false;
  }

  return words.every(word =>
    /^[A-Za-zÀ-ÿ'’-]+$/.test(word)
  );
}

// ============================================================
// CAPITALISE
// ============================================================

function capitalize(value) {
  if (!value) {
    return "";
  }

  return (
    value.charAt(0).toUpperCase() +
    value.slice(1)
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
        "Please reply *YES* to continue or *NO* to go back."
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
      return getGenderSelection();
    }

    const available =
      await getRemainingSpaces(
        gender
      );

    if (available <= 0) {
      bookingStates.delete(phone);

      return (
        `❌ There are currently no ${gender} spaces available.\n\n` +
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
      `🏸 *${capitalize(
        gender
      )}'s spaces*\n\n` +
      `There are *${available}* spaces available.\n\n` +
      "How many spaces would you like to book?\n\n" +
      "1️⃣ *1 space*\n" +
      "2️⃣ *2 spaces*\n" +
      "3️⃣ *3 spaces*\n\n" +
      "Maximum 3 spaces per booking."
    );
  }

  // ----------------------------------------------------------
  // CHOOSE QUANTITY
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
        "Please reply with *1*, *2* or *3*.\n\n" +
        "Maximum 3 spaces per booking."
      );
    }

    const available =
      await getRemainingSpaces(
        state.gender
      );

    if (quantity > available) {
      return (
        `❌ There ${
          available === 1
            ? "is only 1 space"
            : `are only ${available} spaces`
        } available.\n\n` +
        "Please choose a smaller number."
      );
    }

    bookingStates.set(
      phone,
      {
        ...state,
        step: "attendee_name",
        quantity,
        attendeeNames: [],
        attendeeIndex: 0
      }
    );

    return (
      `👤 *Attendee 1 of ${quantity}*\n\n` +
      "Please send the *full name* of this attendee."
    );
  }

  // ----------------------------------------------------------
  // ATTENDEE NAMES
  // ----------------------------------------------------------

  if (
    state.step ===
    "attendee_name"
  ) {
    if (!isValidFullName(text)) {
      return (
        "❌ Please enter the attendee's *full name*.\n\n" +
        "For example: *John Smith*"
      );
    }

    const attendeeNames =
      Array.isArray(
        state.attendeeNames
      )
        ? [
            ...state.attendeeNames,
            text.trim()
          ]
        : [text.trim()];

    const nextIndex =
      attendeeNames.length;

    if (
      nextIndex < state.quantity
    ) {
      bookingStates.set(
        phone,
        {
          ...state,
          attendeeNames,
          attendeeIndex: nextIndex
        }
      );

      return (
        `👤 *Attendee ${
          nextIndex + 1
        } of ${state.quantity}*\n\n` +
        "Please send the *full name* of this attendee."
      );
    }

    bookingStates.set(
      phone,
      {
        ...state,
        step: "booking_confirmation",
        attendeeNames
      }
    );

    const total =
      state.quantity *
      Number(
        badmintonSession.pricePerSpace
      );

    return (
      "📝 *Booking Summary*\n\n" +
      `📅 ${badmintonSession.date}\n` +
      `🕖 ${badmintonSession.startTime} - ${badmintonSession.endTime}\n` +
      `📍 ${badmintonSession.venue}\n\n` +
      `👤 Category: *${capitalize(
        state.gender
      )}*\n` +
      `🎟️ Spaces: *${state.quantity}*\n\n` +
      "👥 *Attendees*\n" +
      attendeeNames
        .map(
          (name, index) =>
            `${index + 1}. ${name}`
        )
        .join("\n") +
      "\n\n" +
      `💷 *Total: £${total.toFixed(
        2
      )}*\n\n` +
      "Reply *YES* to continue to payment.\n" +
      "Reply *NO* to cancel."
    );
  }

  // ----------------------------------------------------------
  // CONFIRM BOOKING
  // ----------------------------------------------------------

  if (
    state.step ===
    "booking_confirmation"
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
        "Please reply *YES* to continue to payment or *NO* to cancel."
      );
    }

    // Re-check availability immediately
    // before creating the payment link.

    const available =
      await getRemainingSpaces(
        state.gender
      );

    if (
      available < state.quantity
    ) {
      bookingStates.delete(phone);

      return (
        "❌ Unfortunately, those spaces have just been taken.\n\n" +
        `Only *${available}* ${state.gender} space${
          available === 1
            ? ""
            : "s"
        } remain.\n\n` +
        "Please start a new booking."
      );
    }

    const amount =
      state.quantity *
      Number(
        badmintonSession.pricePerSpace
      );

    const pendingBooking = {
      phone,
      gender: state.gender,
      quantity: state.quantity,
      status: "pending",
      attendee_names:
        state.attendeeNames,
      amount,
      payment_status: "pending"
    };

    try {
      // --------------------------------------------------------
      // CREATE BOOKING FIRST
      // --------------------------------------------------------

      const inserted =
        await supabaseRequest(
          "bookings",
          {
            method: "POST",
            headers: {
              Prefer:
                "return=representation"
            },
            body: JSON.stringify(
              pendingBooking
            )
          }
        );

      const booking =
        inserted?.[0];

      if (!booking) {
        throw new Error(
          "Booking could not be created."
        );
      }

      // --------------------------------------------------------
      // SAVE ATTENDEES
      // --------------------------------------------------------

      await saveAttendees(
        booking.id,
        phone,
        state.gender,
        state.attendeeNames
      );

      // --------------------------------------------------------
      // CREATE SQUARE PAYMENT
      // --------------------------------------------------------

      const square =
        await createSquarePaymentLink(
          {
            ...booking,
            amount
          }
        );

      await supabaseRequest(
        `bookings?id=eq.${booking.id}`,
        {
          method: "PATCH",
          headers: {
            Prefer:
              "return=minimal"
          },
          body: JSON.stringify({
            square_order_id:
              square.squareOrderId,
            square_payment_link_id:
              square.squarePaymentLinkId
          })
        }
      );

      bookingStates.delete(phone);

      return (
        "💳 *Payment Required*\n\n" +
        `Your total is *£${amount.toFixed(
          2
        )}*.\n\n` +
        "Please complete your payment using the secure Square payment link below:\n\n" +
        `${square.paymentLink}\n\n` +
        "⚠️ Your spaces are only confirmed once Square confirms your payment.\n\n" +
        "After payment, you'll automatically receive your booking confirmation here on WhatsApp."
      );
    } catch (error) {
      console.error(
        "❌ Booking/payment creation error:",
        error
      );

      bookingStates.delete(phone);

      return (
        "❌ Sorry, I couldn't create the payment link right now.\n\n" +
        "Please try again in a moment."
      );
    }
  }

  return (
    "Something went wrong with your booking.\n\n" +
    "Reply *menu* to start again."
  );
}

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

  // ----------------------------------------------------------
  // CANCEL / MENU
  // ----------------------------------------------------------

  if (
    command === "cancel" ||
    command === "menu"
  ) {
    bookingStates.delete(phone);

    return getMainMenu();
  }

  // ----------------------------------------------------------
  // GREETING
  // ----------------------------------------------------------

  if (
    command === "hi" ||
    command === "hello" ||
    command === "start"
  ) {
    bookingStates.delete(phone);

    return getMainMenu();
  }

  // ----------------------------------------------------------
  // ACTIVE BOOKING
  // ----------------------------------------------------------

  if (state) {
    return await handleBookingFlow(
      phone,
      text,
      state
    );
  }

  // ----------------------------------------------------------
  // BOOK
  // ----------------------------------------------------------

  if (
    command === "1" ||
    command === "book" ||
    command === "booking"
  ) {
    if (!badmintonSession) {
      return (
        "❌ There is currently no session available to book."
      );
    }

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

  // ----------------------------------------------------------
  // AVAILABILITY
  // ----------------------------------------------------------

  if (
    command === "2" ||
    command === "spaces" ||
    command === "space" ||
    command === "availability"
  ) {
    return await getAvailabilityMessage();
  }

  // ----------------------------------------------------------
  // MY BOOKING
  // ----------------------------------------------------------

  if (
    command === "3" ||
    command === "my booking"
  ) {
    return await getMyBooking(
      phone
    );
  }

  // ----------------------------------------------------------
  // MY DETAILS
  // ----------------------------------------------------------

  if (
    command === "4" ||
    command === "my details" ||
    command === "details"
  ) {
    try {
      const customer =
        await getCustomer(phone);

      if (!customer) {
        return (
          "👤 *Your Details*\n\n" +
          "I don't have your details yet.\n\n" +
          "Please complete a booking first."
        );
      }

      return (
        "👤 *Your Details*\n\n" +
        `Name: ${customer.name || "Not set"}\n` +
        `Points: ${Number(
          customer.points || 0
        )}\n` +
        `Payment: ${
          customer.paid
            ? "Paid ✅"
            : "Not paid ❌"
        }`
      );
    } catch {
      return (
        "❌ Sorry, I couldn't load your details."
      );
    }
  }

  // ----------------------------------------------------------
  // RANKINGS
  // ----------------------------------------------------------

  if (
    command === "5" ||
    command === "ranking" ||
    command === "rankings"
  ) {
    return await getRanking();
  }

  return (
    "🏸 I didn't understand that.\n\n" +
    "Reply *menu* to see what I can do."
  );
}

// ============================================================
// SQUARE WEBHOOK
// IMPORTANT: MUST COME BEFORE BODY PARSERS
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

      // --------------------------------------------------------
      // VERIFY SIGNATURE
      // --------------------------------------------------------

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
            "❌ Invalid Square webhook signature."
          );

          return res.sendStatus(403);
        }
      }

      const event =
        JSON.parse(rawBody);

      console.log(
        `💳 Square event received: ${event.type}`
      );

      // --------------------------------------------------------
      // DUPLICATE EVENT PROTECTION
      // --------------------------------------------------------

      if (
        event.event_id &&
        processedSquareEvents.has(
          event.event_id
        )
      ) {
        console.log(
          `ℹ️ Square event ${event.event_id} already processed.`
        );

        return res.sendStatus(200);
      }

      // --------------------------------------------------------
      // PAYMENT UPDATED
      // --------------------------------------------------------

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
// BODY PARSERS
// ============================================================

// JSON is required for WhatsApp webhook requests.
app.use(express.json());

// URL-encoded data is required by the HTML Admin form.
// THIS FIXES THE "req.body IS UNDEFINED" ERROR.
app.use(
  express.urlencoded({
    extended: true
  })
);

// ============================================================
// HOME
// ============================================================

app.get("/", (req, res) => {
  res.status(200).send(
    "🏸 Badminton Bot is running!"
  );
});

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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy - Badminton Bot</title>
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
the Badminton Bot service, including responding to your
requests and helping organise badminton activities.
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
If you have questions about this Privacy Policy or
want to request deletion of personal information,
contact:
</p>

<p>
<strong>hassan307@hotmail.co.uk</strong>
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
Your booking confirmation will be sent to you
on WhatsApp once Square confirms the payment.
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

<p>Your spaces have not been booked.</p>

<p>Return to WhatsApp if you would like to try again.</p>

</body>
</html>
`);
  }
);

// ============================================================
// META WEBHOOK VERIFICATION
// ============================================================

app.get(
  "/webhook",
  (req, res) => {
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
        "✅ WhatsApp webhook verified."
      );

      return res
        .status(200)
        .send(challenge);
    }

    console.log(
      "❌ WhatsApp webhook verification failed."
    );

    return res.sendStatus(403);
  }
);

// ============================================================
// META WEBHOOK RECEIVE
// ============================================================

app.post(
  "/webhook",
  async (req, res) => {
    // Respond immediately to Meta.
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
// ADMIN AUTH
// ============================================================

function adminAuth(
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

    return res.sendStatus(401);
  }

  const encoded =
    auth.split(" ")[1];

  if (!encoded) {
    return res.sendStatus(401);
  }

  let decoded;

  try {
    decoded =
      Buffer.from(
        encoded,
        "base64"
      ).toString("utf8");
  } catch {
    return res.sendStatus(401);
  }

  const separator =
    decoded.indexOf(":");

  const username =
    separator >= 0
      ? decoded.slice(
          0,
          separator
        )
      : "";

  const password =
    separator >= 0
      ? decoded.slice(
          separator + 1
        )
      : "";

  if (
    password !== ADMIN_PASSWORD
  ) {
    return res.sendStatus(401);
  }

  next();
}

// ============================================================
// ADMIN DASHBOARD
// ============================================================

app.get(
  "/admin",
  adminAuth,
  async (req, res) => {
    try {
      await loadSession();

      const bookings =
        await getAllBookings();

      const paidBookings =
        bookings.filter(
          booking =>
            booking.status === "paid"
        );

      const pendingBookings =
        bookings.filter(
          booking =>
            booking.status === "pending"
        );

      const menUsed =
        paidBookings
          .filter(
            booking =>
              booking.gender === "men"
          )
          .reduce(
            (sum, booking) =>
              sum +
              Number(
                booking.quantity || 0
              ),
            0
          );

      const womenUsed =
        paidBookings
          .filter(
            booking =>
              booking.gender === "women"
          )
          .reduce(
            (sum, booking) =>
              sum +
              Number(
                booking.quantity || 0
              ),
            0
          );

      const totalPaidSpaces =
        menUsed + womenUsed;

      const menRemaining =
        Math.max(
          0,
          Number(
            badmintonSession?.menCapacity ||
              0
          ) - menUsed
        );

      const womenRemaining =
        Math.max(
          0,
          Number(
            badmintonSession?.womenCapacity ||
              0
          ) - womenUsed
        );

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
  padding: 30px;
  color: #222;
}

.container {
  max-width: 1200px;
  margin: auto;
}

h1 {
  margin-bottom: 30px;
}

.card {
  background: white;
  border-radius: 12px;
  padding: 25px;
  margin-bottom: 25px;
  box-shadow: 0 2px 8px rgba(0,0,0,.08);
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(auto-fit, minmax(180px, 1fr));
  gap: 15px;
}

.stat {
  background: #fafafa;
  border-radius: 10px;
  padding: 20px;
}

.stat strong {
  display: block;
  font-size: 28px;
  margin-top: 5px;
}

label {
  display: block;
  font-weight: bold;
  margin-top: 15px;
  margin-bottom: 6px;
}

input {
  width: 100%;
  box-sizing: border-box;
  padding: 12px;
  border: 1px solid #ccc;
  border-radius: 7px;
  font-size: 16px;
}

button {
  margin-top: 20px;
  padding: 12px 20px;
  border: 0;
  border-radius: 7px;
  background: #111;
  color: white;
  font-size: 16px;
  cursor: pointer;
}

button:hover {
  opacity: .9;
}

.table-wrap {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th, td {
  text-align: left;
  padding: 12px;
  border-bottom: 1px solid #ddd;
  vertical-align: top;
}

.badge-paid {
  color: green;
  font-weight: bold;
}

.badge-pending {
  color: #b36b00;
  font-weight: bold;
}

</style>

</head>

<body>

<div class="container">

<h1>🏸 Badminton Admin</h1>

<div class="card">

<h2>Current Session</h2>

<form method="POST"
action="/admin/session">

<label>Date</label>
<input
  type="text"
  name="date"
  value="${escapeHtml(
    badmintonSession?.date || ""
  )}"
  required
>

<label>Start Time</label>
<input
  type="text"
  name="startTime"
  value="${escapeHtml(
    badmintonSession?.startTime || ""
  )}"
  required
>

<label>End Time</label>
<input
  type="text"
  name="endTime"
  value="${escapeHtml(
    badmintonSession?.endTime || ""
  )}"
  required
>

<label>Venue</label>
<input
  type="text"
  name="venue"
  value="${escapeHtml(
    badmintonSession?.venue || ""
  )}"
  required
>

<label>Price Per Space (£)</label>
<input
  type="number"
  step="0.01"
  min="0"
  name="pricePerSpace"
  value="${Number(
    badmintonSession?.pricePerSpace || 0
  ).toFixed(2)}"
  required
>

<label>Men Capacity</label>
<input
  type="number"
  min="0"
  name="menCapacity"
  value="${Number(
    badmintonSession?.menCapacity || 0
  )}"
  required
>

<label>Women Capacity</label>
<input
  type="number"
  min="0"
  name="womenCapacity"
  value="${Number(
    badmintonSession?.womenCapacity || 0
  )}"
  required
>

<label>Total Capacity</label>
<input
  type="number"
  min="0"
  name="totalCapacity"
  value="${Number(
    badmintonSession?.totalCapacity || 0
  )}"
  required
>

<button type="submit">
Save Session Details
</button>

</form>

</div>

<div class="card">

<h2>Availability</h2>

<div class="grid">

<div class="stat">
Men Available
<strong>${menRemaining}</strong>
</div>

<div class="stat">
Women Available
<strong>${womenRemaining}</strong>
</div>

<div class="stat">
Paid Spaces
<strong>${totalPaidSpaces}</strong>
</div>

<div class="stat">
Pending Bookings
<strong>${pendingBookings.length}</strong>
</div>

</div>

</div>

<div class="card">

<h2>Bookings</h2>

<div class="table-wrap">

<table>

<thead>

<tr>
<th>ID</th>
<th>Phone</th>
<th>Gender</th>
<th>Spaces</th>
<th>Attendees</th>
<th>Amount</th>
<th>Status</th>
<th>Created</th>
</tr>

</thead>

<tbody>

${
  bookings.length
    ? bookings
        .map(
          booking => `
<tr>

<td>${booking.id}</td>

<td>
${escapeHtml(
  booking.phone || ""
)}
</td>

<td>
${escapeHtml(
  capitalize(
    booking.gender || ""
  )
)}
</td>

<td>
${Number(
  booking.quantity || 0
)}
</td>

<td>
${
  Array.isArray(
    booking.attendee_names
  )
    ? booking.attendee_names
        .map(
          name =>
            escapeHtml(name)
        )
        .join("<br>")
    : ""
}
</td>

<td>
£${Number(
  booking.amount || 0
).toFixed(2)}
</td>

<td>
<span class="${
  booking.status === "paid"
    ? "badge-paid"
    : "badge-pending"
}">
${escapeHtml(
  booking.status || ""
)}
</span>
</td>

<td>
${escapeHtml(
  booking.created_at
    ? new Date(
        booking.created_at
      ).toLocaleString("en-GB")
    : ""
)}
</td>

</tr>
`
        )
        .join("")
    : `
<tr>
<td colspan="8">
No bookings yet.
</td>
</tr>
`
}

</tbody>

</table>

</div>

</div>

</div>

</body>
</html>
`);
    } catch (error) {
      console.error(
        "❌ Admin dashboard error:",
        error
      );

      res.status(500).send(
        "Could not load admin dashboard."
      );
    }
  }
);

// ============================================================
// ADMIN SESSION UPDATE
// ============================================================

app.post(
  "/admin/session",
  adminAuth,
  async (req, res) => {
    try {
      // express.urlencoded() above means
      // req.body is now available for the HTML form.

      const {
        date,
        startTime,
        endTime,
        venue,
        pricePerSpace,
        menCapacity,
        womenCapacity,
        totalCapacity
      } = req.body;

      if (
        !date ||
        !startTime ||
        !endTime ||
        !venue
      ) {
        return res
          .status(400)
          .send(
            "❌ Date, time and venue are required."
          );
      }

      const price =
        Number(pricePerSpace);

      const men =
        Number(menCapacity);

      const women =
        Number(womenCapacity);

      const total =
        Number(totalCapacity);

      if (
        !Number.isFinite(price) ||
        price < 0
      ) {
        return res
          .status(400)
          .send(
            "❌ Invalid price."
          );
      }

      if (
        !Number.isInteger(men) ||
        men < 0
      ) {
        return res
          .status(400)
          .send(
            "❌ Invalid men's capacity."
          );
      }

      if (
        !Number.isInteger(women) ||
        women < 0
      ) {
        return res
          .status(400)
          .send(
            "❌ Invalid women's capacity."
          );
      }

      if (
        !Number.isInteger(total) ||
        total < 0
      ) {
        return res
          .status(400)
          .send(
            "❌ Invalid total capacity."
          );
      }

      if (
        men + women !== total
      ) {
        return res
          .status(400)
          .send(
            "❌ Total capacity must equal Men Capacity + Women Capacity."
          );
      }

      await saveSession({
        date: date.trim(),
        startTime: startTime.trim(),
        endTime: endTime.trim(),
        venue: venue.trim(),
        pricePerSpace: price,
        menCapacity: men,
        womenCapacity: women,
        totalCapacity: total
      });

      console.log(
        "✅ Session updated from Admin."
      );

      res.redirect(
        "/admin"
      );
    } catch (error) {
      console.error(
        "❌ Could not save session:",
        error
      );

      res
        .status(500)
        .send(
          "Could not save session."
        );
    }
  }
);

// ============================================================
// ESCAPE HTML
// ============================================================

function escapeHtml(value) {
  return String(value ?? "")
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
// START SERVER
// ============================================================

async function startServer() {
  try {
    await loadSession();

    if (!badmintonSession) {
      console.warn(
        "⚠️ Server starting without a loaded session."
      );
    }

    app.listen(
      PORT,
      () => {
        console.log(
          `🚀 Badminton Bot running on port ${PORT}`
        );

        console.log(
          `🌐 Base URL: ${BASE_URL}`
        );

        console.log(
          `💳 Square environment: ${SQUARE_ENVIRONMENT}`
        );
      }
    );
  } catch (error) {
    console.error(
      "❌ Server startup error:",
      error
    );

    process.exit(1);
  }
}

startServer();
