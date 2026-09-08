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
  `http://localhost:${PORT}`;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY;

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD;

// ============================================================
// SQUARE API
// ============================================================

const SQUARE_API_BASE =
  SQUARE_ENVIRONMENT.toLowerCase() === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";

// ============================================================
// EXPRESS
// ============================================================

// IMPORTANT:
// Square webhook MUST receive the raw body for signature checking.
// This route is therefore registered before express.json().

app.post(
  "/square/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const rawBody = req.body.toString("utf8");

      const signature =
        req.headers["x-square-hmacsha256-signature"];

      const notificationUrl =
        `${BASE_URL}/square/webhook`;

      // --------------------------------------------------------
      // VERIFY SIGNATURE
      // --------------------------------------------------------

      if (SQUARE_WEBHOOK_SIGNATURE_KEY) {
        if (!signature) {
          console.error(
            "❌ Square webhook missing signature"
          );

          return res.sendStatus(403);
        }

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

      const event = JSON.parse(rawBody);

      console.log(
        `💳 Square event: ${event.type}`
      );

      // --------------------------------------------------------
      // PAYMENT UPDATED
      // --------------------------------------------------------

      if (event.type === "payment.updated") {
        await handleSquarePaymentUpdated(event);
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

// Normal JSON parser for everything else.

app.use(express.json());

// ============================================================
// SUPABASE HELPERS
// ============================================================

async function supabaseRequest(
  table,
  method = "GET",
  query = "",
  body = null
) {
  if (
    !SUPABASE_URL ||
    !SUPABASE_SECRET_KEY
  ) {
    throw new Error(
      "Supabase environment variables are missing."
    );
  }

  const url =
    `${SUPABASE_URL}/rest/v1/${table}${query}`;

  const headers = {
    "apikey": SUPABASE_SECRET_KEY,
    "Authorization":
      `Bearer ${SUPABASE_SECRET_KEY}`,
    "Content-Type": "application/json"
  };

  if (
    method === "POST" ||
    method === "PATCH" ||
    method === "DELETE"
  ) {
    headers["Prefer"] =
      "return=representation";
  }

  const options = {
    method,
    headers
  };

  if (body !== null) {
    options.body =
      JSON.stringify(body);
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
      `❌ Supabase ${method} ${table}:`,
      data
    );

    throw new Error(
      `Supabase error ${response.status}`
    );
  }

  return data;
}

// ============================================================
// SESSION
// ============================================================

let badmintonSession = {
  id: null,
  date: "Saturday 12 September",
  startTime: "7:00 PM",
  endTime: "9:00 PM",
  venue: "Peckham Sports Centre",
  pricePerSpace: 8,
  menCapacity: 12,
  womenCapacity: 12,
  totalCapacity: 24
};

// ============================================================
// LOAD SESSION FROM SUPABASE
// ============================================================

async function loadSession() {
  try {
    const data =
      await supabaseRequest(
        "sessions",
        "GET",
        "?select=*&order=id.asc&limit=1"
      );

    if (
      Array.isArray(data) &&
      data.length > 0
    ) {
      const row = data[0];

      badmintonSession = {
        id: row.id,

        date:
          row.session_date,

        startTime:
          row.start_time,

        endTime:
          row.end_time,

        venue:
          row.venue,

        pricePerSpace:
          Number(row.price_per_space),

        menCapacity:
          Number(row.men_capacity),

        womenCapacity:
          Number(row.women_capacity),

        totalCapacity:
          Number(row.total_capacity)
      };

      console.log(
        "✅ Session loaded from Supabase:",
        badmintonSession
      );

      return;
    }

    console.log(
      "⚠️ No session found. Creating default session."
    );

    const created =
      await supabaseRequest(
        "sessions",
        "POST",
        "",
        {
          session_date:
            badmintonSession.date,

          start_time:
            badmintonSession.startTime,

          end_time:
            badmintonSession.endTime,

          venue:
            badmintonSession.venue,

          price_per_space:
            badmintonSession.pricePerSpace,

          men_capacity:
            badmintonSession.menCapacity,

          women_capacity:
            badmintonSession.womenCapacity,

          total_capacity:
            badmintonSession.totalCapacity
        }
      );

    if (
      Array.isArray(created) &&
      created.length > 0
    ) {
      badmintonSession.id =
        created[0].id;
    }

  } catch (error) {
    console.error(
      "❌ Could not load session:",
      error.message
    );
  }
}

// ============================================================
// SAVE SESSION
// ============================================================

async function saveSession() {
  if (!badmintonSession.id) {
    await loadSession();
  }

  if (!badmintonSession.id) {
    throw new Error(
      "No session ID available."
    );
  }

  const totalCapacity =
    badmintonSession.menCapacity +
    badmintonSession.womenCapacity;

  badmintonSession.totalCapacity =
    totalCapacity;

  await supabaseRequest(
    "sessions",
    "PATCH",
    `?id=eq.${badmintonSession.id}`,
    {
      session_date:
        badmintonSession.date,

      start_time:
        badmintonSession.startTime,

      end_time:
        badmintonSession.endTime,

      venue:
        badmintonSession.venue,

      price_per_space:
        badmintonSession.pricePerSpace,

      men_capacity:
        badmintonSession.menCapacity,

      women_capacity:
        badmintonSession.womenCapacity,

      total_capacity:
        badmintonSession.totalCapacity
    }
  );

  console.log(
    "✅ Session saved to Supabase"
  );
}

// ============================================================
// BOOKING STATE
// ============================================================

const bookingStates = new Map();

// ============================================================
// LOAD / SAVE BOOKINGS
// ============================================================

async function getBookings() {
  return await supabaseRequest(
    "bookings",
    "GET",
    "?select=*&order=id.desc"
  );
}

async function getBookingById(id) {
  const data =
    await supabaseRequest(
      "bookings",
      "GET",
      `?id=eq.${id}&select=*`
    );

  return data?.[0] || null;
}

async function getPendingBookingByOrderId(
  orderId
) {
  const data =
    await supabaseRequest(
      "bookings",
      "GET",
      `?square_order_id=eq.${encodeURIComponent(
        orderId
      )}&select=*`
    );

  return data?.[0] || null;
}

// ============================================================
// CUSTOMERS
// ============================================================

async function getCustomer(phone) {
  const data =
    await supabaseRequest(
      "customers",
      "GET",
      `?phone=eq.${encodeURIComponent(
        phone
      )}&select=*`
    );

  return data?.[0] || null;
}

async function saveCustomer(
  phone,
  name,
  paid = false
) {
  const existing =
    await getCustomer(phone);

  if (existing) {
    const updated =
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
              ? "paid"
              : existing.payment_status
        }
      );

    return updated?.[0] || existing;
  }

  const created =
    await supabaseRequest(
      "customers",
      "POST",
      "",
      {
        phone,
        name,
        points: 0,
        paid,
        payment_status:
          paid
            ? "paid"
            : "unpaid"
      }
    );

  return created?.[0] || null;
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
  for (const name of names) {
    await supabaseRequest(
      "attendees",
      "POST",
      "",
      {
        booking_id: bookingId,
        name,
        phone,
        gender
      }
    );
  }
}

// ============================================================
// RANKINGS
// ============================================================

async function addRankingPoints(
  phone,
  name
) {
  const existing =
    await supabaseRequest(
      "rankings",
      "GET",
      `?phone=eq.${encodeURIComponent(
        phone
      )}&select=*`
    );

  if (
    Array.isArray(existing) &&
    existing.length > 0
  ) {
    await supabaseRequest(
      "rankings",
      "PATCH",
      `?phone=eq.${encodeURIComponent(
        phone
      )}`,
      {
        name,
        points:
          Number(existing[0].points || 0) + 1
      }
    );

    return;
  }

  await supabaseRequest(
    "rankings",
    "POST",
    "",
    {
      phone,
      name,
      points: 1
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
  const url =
    `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;

  const response =
    await fetch(url, {
      method: "POST",

      headers: {
        "Authorization":
          `Bearer ${WHATSAPP_TOKEN}`,

        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        messaging_product: "whatsapp",

        to,

        type: "text",

        text: {
          body: message
        }
      })
    });

  const data =
    await response.json();

  if (!response.ok) {
    console.error(
      "❌ WhatsApp error:",
      data
    );

    throw new Error(
      "WhatsApp message failed."
    );
  }

  return data;
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
// AVAILABILITY
// ============================================================

async function getRemainingSpaces(
  gender
) {
  const bookings =
    await getBookings();

  const paidBookings =
    bookings.filter(
      booking =>
        booking.status === "paid"
    );

  const used =
    paidBookings.reduce(
      (total, booking) => {
        if (
          booking.gender === gender
        ) {
          return (
            total +
            Number(booking.quantity || 0)
          );
        }

        return total;
      },
      0
    );

  const capacity =
    gender === "men"
      ? badmintonSession.menCapacity
      : badmintonSession.womenCapacity;

  return Math.max(
    capacity - used,
    0
  );
}

async function getAvailabilityMessage() {
  const men =
    await getRemainingSpaces("men");

  const women =
    await getRemainingSpaces("women");

  return (
    "🏸 *Availability*\n\n" +

    `👨 Men: *${men} spaces remaining*\n` +
    `👩 Women: *${women} spaces remaining*\n\n` +

    `💷 £${badmintonSession.pricePerSpace} per space\n\n` +

    `📅 ${badmintonSession.date}\n` +
    `🕖 ${badmintonSession.startTime} - ${badmintonSession.endTime}\n` +
    `📍 ${badmintonSession.venue}`
  );
}

// ============================================================
// VALIDATE FULL NAME
// ============================================================

function isValidFullName(name) {
  const cleaned =
    name.trim();

  const parts =
    cleaned.split(/\s+/);

  if (
    parts.length < 2 ||
    parts.length > 6
  ) {
    return false;
  }

  return parts.every(part =>
    /^[A-Za-zÀ-ÖØ-öø-ÿ'’-]+$/.test(
      part
    )
  );
}

// ============================================================
// WHATSAPP MESSAGE HANDLER
// ============================================================

app.post("/webhook", async (req, res) => {
  // Respond to Meta immediately.
  res.sendStatus(200);

  try {
    const value =
      req.body?.entry?.[0]?.changes?.[0]?.value;

    const message =
      value?.messages?.[0];

    if (!message) {
      return;
    }

    const phone =
      message.from;

    const text =
      message?.text?.body?.trim() || "";

    if (!text) {
      return;
    }

    console.log(
      `📩 WhatsApp message from ${phone}: ${text}`
    );

    const reply =
      await handleMessage(
        phone,
        text
      );

    if (reply) {
      await sendWhatsAppMessage(
        phone,
        reply
      );
    }

  } catch (error) {
    console.error(
      "❌ WhatsApp handler error:",
      error
    );
  }
});

// ============================================================
// MAIN MESSAGE LOGIC
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
  // CANCEL
  // ----------------------------------------------------------

  if (
    command === "cancel"
  ) {
    bookingStates.delete(phone);

    return getMainMenu();
  }

  // ----------------------------------------------------------
  // MENU
  // ----------------------------------------------------------

  if (
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
    command === "hey" ||
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
    const customer =
      await getCustomer(phone);

    if (!customer) {
      return (
        "👤 *Your Details*\n\n" +

        "I don't have your details yet.\n\n" +

        "Please send me your full name."
      );
    }

    return (
      "👤 *Your Details*\n\n" +

      `Name: ${customer.name || "Not saved"}\n` +

      `Points: ${customer.points || 0}\n` +

      `Payment: ${
        customer.paid
          ? "Paid ✅"
          : "Not paid ❌"
      }`
    );
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

  // ----------------------------------------------------------
  // SAVE NAME
  // ----------------------------------------------------------

  if (
    isValidFullName(text)
  ) {
    await saveCustomer(
      phone,
      text.trim()
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

    return (
      "👤 *Who are you booking for?*\n\n" +

      "Reply:\n\n" +

      "1️⃣ *Men*\n" +
      "2️⃣ *Women*"
    );
  }

  // ----------------------------------------------------------
  // GENDER
  // ----------------------------------------------------------

  if (
    state.step === "choose_gender"
  ) {
    let gender;

    if (
      command === "1" ||
      command === "men" ||
      command === "male"
    ) {
      gender = "men";
    }

    if (
      command === "2" ||
      command === "women" ||
      command === "female"
    ) {
      gender = "women";
    }

    if (!gender) {
      return (
        "Please reply *1* for Men " +
        "or *2* for Women."
      );
    }

    const remaining =
      await getRemainingSpaces(
        gender
      );

    if (remaining <= 0) {
      bookingStates.delete(phone);

      return (
        "❌ Sorry, there are no spaces " +
        `remaining in the ${gender} section.\n\n` +

        "Reply *menu* to return to the menu."
      );
    }

    bookingStates.set(
      phone,
      {
        step: "choose_quantity",
        gender
      }
    );

    const max =
      Math.min(
        3,
        remaining
      );

    return (
      `👥 *How many spaces?*\n\n` +

      `You can book up to *${max}* space${
        max === 1 ? "" : "s"
      }.\n\n` +

      "Reply with *1*, *2* or *3*."
    );
  }

  // ----------------------------------------------------------
  // QUANTITY
  // ----------------------------------------------------------

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
        "Please choose between *1 and 3 spaces*."
      );
    }

    const remaining =
      await getRemainingSpaces(
        state.gender
      );

    if (
      quantity > remaining
    ) {
      return (
        `❌ There are only *${remaining}* ` +
        `space${
          remaining === 1
            ? ""
            : "s"
        } remaining.`
      );
    }

    bookingStates.set(
      phone,
      {
        ...state,
        step: "collect_names",
        quantity,
        names: [],
        nameIndex: 0
      }
    );

    return (
      "📝 *Attendee names*\n\n" +

      `Please send the full name of attendee *1*.\n\n` +

      "Example: John Smith"
    );
  }

  // ----------------------------------------------------------
  // COLLECT NAMES
  // ----------------------------------------------------------

  if (
    state.step === "collect_names"
  ) {
    if (
      !isValidFullName(text)
    ) {
      return (
        "Please enter the attendee's *full name*.\n\n" +

        "Example: John Smith"
      );
    }

    const names =
      Array.isArray(state.names)
        ? [...state.names]
        : [];

    names.push(
      text.trim()
    );

    const nextIndex =
      names.length + 1;

    if (
      names.length <
      state.quantity
    ) {
      bookingStates.set(
        phone,
        {
          ...state,
          names,
          nameIndex:
            names.length
        }
      );

      return (
        `Thanks! ✅\n\n` +

        `Please send the full name of attendee *${nextIndex}*.`
      );
    }

    const amount =
      Number(
        badmintonSession.pricePerSpace
      ) *
      state.quantity;

    bookingStates.set(
      phone,
      {
        ...state,
        step: "confirm_booking",
        names,
        amount
      }
    );

    let attendeeText = "";

    names.forEach(
      (name, index) => {
        attendeeText +=
          `${index + 1}. ${name}\n`;
      }
    );

    return (
      "🏸 *Booking Summary*\n\n" +

      `📅 ${badmintonSession.date}\n` +
      `🕖 ${badmintonSession.startTime} - ${badmintonSession.endTime}\n` +
      `📍 ${badmintonSession.venue}\n\n` +

      `Category: ${
        state.gender === "men"
          ? "Men"
          : "Women"
      }\n` +

      `Spaces: ${state.quantity}\n\n` +

      "*Attendees:*\n" +

      attendeeText +

      `\n💷 Total: *£${amount.toFixed(2)}*\n\n` +

      "Reply *YES* to continue to payment.\n" +
      "Reply *NO* to cancel."
    );
  }

  // ----------------------------------------------------------
  // CONFIRM BOOKING
  // ----------------------------------------------------------

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
        "Please reply *YES* to continue " +
        "or *NO* to cancel."
      );
    }

    // Check availability again immediately
    // before creating the payment link.

    const remaining =
      await getRemainingSpaces(
        state.gender
      );

    if (
      state.quantity > remaining
    ) {
      bookingStates.delete(phone);

      return (
        "❌ Unfortunately, those spaces " +
        "are no longer available.\n\n" +

        await getAvailabilityMessage()
      );
    }

    try {
      const payment =
        await createSquarePaymentLink(
          phone,
          state
        );

      const booking =
        await supabaseRequest(
          "bookings",
          "POST",
          "",
          {
            phone,

            gender:
              state.gender,

            quantity:
              state.quantity,

            status:
              "pending",

            attendee_names:
              state.names,

            amount:
              state.amount,

            square_payment_link:
              payment.url,

            square_payment_link_id:
              payment.id,

            square_order_id:
              payment.orderId,

            payment_status:
              "pending"
          }
        );

      const bookingId =
        booking?.[0]?.id;

      if (bookingId) {
        await saveAttendees(
          bookingId,
          phone,
          state.gender,
          state.names
        );
      }

      bookingStates.delete(
        phone
      );

      return (
        "💳 *Payment required*\n\n" +

        `Total: *£${Number(
          state.amount
        ).toFixed(2)}*\n\n` +

        "Please complete your payment using this link:\n\n" +

        payment.url +

        "\n\n" +

        "⚠️ Your spaces are only confirmed " +
        "after Square confirms your payment.\n\n" +

        "Once payment is confirmed, " +
        "I'll send your booking confirmation here on WhatsApp."
      );

    } catch (error) {
      console.error(
        "❌ Payment link error:",
        error
      );

      return (
        "❌ I couldn't create the payment link.\n\n" +

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
// SQUARE PAYMENT LINK
// ============================================================

async function createSquarePaymentLink(
  phone,
  state
) {
  const url =
    `${SQUARE_API_BASE}/v2/online-checkout/payment-links`;

  const idempotencyKey =
    crypto.randomUUID();

  const body = {
    idempotency_key:
      idempotencyKey,

    quick_pay: {
      name:
        `Badminton - ${badmintonSession.date}`,

      price_money: {
        amount:
          Math.round(
            Number(state.amount) * 100
          ),

        currency: "GBP"
      },

      location_id:
        SQUARE_LOCATION_ID
    },

    checkout_options: {
      redirect_url:
        `${BASE_URL}/payment-success`
    }
  };

  const response =
    await fetch(url, {
      method: "POST",

      headers: {
        "Square-Version":
          "2026-08-19",

        "Authorization":
          `Bearer ${SQUARE_ACCESS_TOKEN}`,

        "Content-Type":
          "application/json"
      },

      body:
        JSON.stringify(body)
    });

  const data =
    await response.json();

  if (!response.ok) {
    console.error(
      "❌ Square payment link error:",
      data
    );

    throw new Error(
      "Square payment link creation failed."
    );
  }

  const paymentLink =
    data.payment_link;

  if (
    !paymentLink ||
    !paymentLink.url
  ) {
    throw new Error(
      "Square did not return a payment link."
    );
  }

  console.log(
    "✅ Square payment link created:",
    paymentLink.url
  );

  return {
    id:
      paymentLink.id,

    url:
      paymentLink.url,

    orderId:
      paymentLink.order_id
  };
}

// ============================================================
// SQUARE WEBHOOK HANDLER
// ============================================================

async function handleSquarePaymentUpdated(
  event
) {
  const payment =
    event.data?.object?.payment;

  if (!payment) {
    console.log(
      "ℹ️ Square event contains no payment."
    );

    return;
  }

  console.log(
    `💳 Payment ${payment.id}: ${payment.status}`
  );

  if (
    payment.status !== "COMPLETED"
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

  const booking =
    await getPendingBookingByOrderId(
      orderId
    );

  if (!booking) {
    console.log(
      `ℹ️ No pending booking found for Square order ${orderId}`
    );

    return;
  }

  // Prevent duplicate processing.

  if (
    booking.status === "paid" &&
    booking.payment_status === "paid"
  ) {
    console.log(
      `ℹ️ Booking ${booking.id} already paid.`
    );

    return;
  }

  // ----------------------------------------------------------
  // FINAL CAPACITY CHECK
  // ----------------------------------------------------------

  const remaining =
    await getRemainingSpaces(
      booking.gender
    );

  if (
    Number(booking.quantity) >
    remaining
  ) {
    console.error(
      `❌ Payment received but insufficient capacity for booking ${booking.id}`
    );

    await supabaseRequest(
      "bookings",
      "PATCH",
      `?id=eq.${booking.id}`,
      {
        payment_status:
          "paid_capacity_issue"
      }
    );

    return;
  }

  // ----------------------------------------------------------
  // MARK BOOKING PAID
  // ----------------------------------------------------------

  await supabaseRequest(
    "bookings",
    "PATCH",
    `?id=eq.${booking.id}`,
    {
      status:
        "paid",

      payment_status:
        "paid",

      square_payment_id:
        payment.id,

      paid_at:
        new Date().toISOString()
    }
  );

  // ----------------------------------------------------------
  // CUSTOMER
  // ----------------------------------------------------------

  const names =
    Array.isArray(
      booking.attendee_names
    )
      ? booking.attendee_names
      : [];

  const primaryName =
    names[0] ||
    "Player";

  await saveCustomer(
    booking.phone,
    primaryName,
    true
  );

  // ----------------------------------------------------------
  // RANKING
  // ----------------------------------------------------------

  for (
    const name of names
  ) {
    // Use attendee name as the ranking name.
    // The payer's phone is associated with the
    // booking for now.

    await addRankingPoints(
      booking.phone,
      name
    );
  }

  // ----------------------------------------------------------
  // WHATSAPP CONFIRMATION
  // ----------------------------------------------------------

  let attendeeText = "";

  names.forEach(
    (name, index) => {
      attendeeText +=
        `${index + 1}. ${name}\n`;
    }
  );

  const message =
    "🎉 *Booking Confirmed!*\n\n" +

    "Your payment has been received and " +
    "your spaces are now confirmed. ✅\n\n" +

    `📅 ${badmintonSession.date}\n` +
    `🕖 ${badmintonSession.startTime} - ${badmintonSession.endTime}\n` +
    `📍 ${badmintonSession.venue}\n\n` +

    "*Attendees:*\n" +

    attendeeText +

    `\n💷 Paid: *£${Number(
      booking.amount
    ).toFixed(2)}*\n\n` +

    "See you on court! 🏸";

  await sendWhatsAppMessage(
    booking.phone,
    message
  );

  console.log(
    `✅ Booking ${booking.id} confirmed and WhatsApp message sent.`
  );
}

// ============================================================
// SQUARE SIGNATURE
// ============================================================

function verifySquareWebhookSignature(
  rawBody,
  signature,
  notificationUrl,
  signatureKey
) {
  const payload =
    notificationUrl +
    rawBody;

  const expected =
    crypto
      .createHmac(
        "sha256",
        signatureKey
      )
      .update(payload)
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

// ============================================================
// MY BOOKING
// ============================================================

async function getMyBooking(phone) {
  const data =
    await supabaseRequest(
      "bookings",
      "GET",
      `?phone=eq.${encodeURIComponent(
        phone
      )}&select=*&order=id.desc&limit=1`
    );

  if (
    !Array.isArray(data) ||
    data.length === 0
  ) {
    return (
      "📋 *My Booking*\n\n" +

      "You don't currently have a booking.\n\n" +

      "Reply *1* to book a space."
    );
  }

  const booking =
    data[0];

  const names =
    Array.isArray(
      booking.attendee_names
    )
      ? booking.attendee_names
      : [];

  let attendeeText = "";

  names.forEach(
    (name, index) => {
      attendeeText +=
        `${index + 1}. ${name}\n`;
    }
  );

  let statusText;

  if (
    booking.status === "paid"
  ) {
    statusText =
      "Confirmed ✅";
  } else {
    statusText =
      "Payment pending ⏳";
  }

  return (
    "📋 *My Booking*\n\n" +

    `Status: ${statusText}\n\n` +

    `📅 ${badmintonSession.date}\n` +
    `🕖 ${badmintonSession.startTime} - ${badmintonSession.endTime}\n` +
    `📍 ${badmintonSession.venue}\n\n` +

    "*Attendees:*\n" +

    attendeeText +

    `\n💷 £${Number(
      booking.amount
    ).toFixed(2)}`
  );
}

// ============================================================
// RANKINGS
// ============================================================

async function getRanking() {
  const data =
    await supabaseRequest(
      "rankings",
      "GET",
      "?select=*&order=points.desc,name.asc&limit=20"
    );

  if (
    !Array.isArray(data) ||
    data.length === 0
  ) {
    return (
      "🏆 *Rankings*\n\n" +

      "No rankings yet."
    );
  }

  let result =
    "🏆 *Badminton Rankings*\n\n";

  data.forEach(
    (player, index) => {
      result +=
        `${index + 1}. ${player.name} — ${player.points} point${
          Number(player.points) === 1
            ? ""
            : "s"
        }\n`;
    }
  );

  return result;
}

// ============================================================
// ADMIN AUTHENTICATION
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
      Buffer
        .from(
          encoded,
          "base64"
        )
        .toString("utf8");
  } catch {
    return res.sendStatus(401);
  }

  const separator =
    decoded.indexOf(":");

  const password =
    separator >= 0
      ? decoded.slice(
          separator + 1
        )
      : "";

  if (
    password !==
    ADMIN_PASSWORD
  ) {
    res.setHeader(
      "WWW-Authenticate",
      'Basic realm="Badminton Admin"'
    );

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
        await getBookings();

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

      const menRemaining =
        await getRemainingSpaces(
          "men"
        );

      const womenRemaining =
        await getRemainingSpaces(
          "women"
        );

      let bookingRows = "";

      for (
        const booking of bookings
      ) {
        const names =
          Array.isArray(
            booking.attendee_names
          )
            ? booking.attendee_names
            : [];

        const nameText =
          names.join(", ");

        bookingRows += `
          <tr>
            <td>${escapeHtml(
              String(booking.id)
            )}</td>

            <td>${escapeHtml(
              booking.phone
            )}</td>

            <td>${escapeHtml(
              booking.gender
            )}</td>

            <td>${escapeHtml(
              String(booking.quantity)
            )}</td>

            <td>${escapeHtml(
              nameText
            )}</td>

            <td>£${Number(
              booking.amount
            ).toFixed(2)}</td>

            <td>${escapeHtml(
              booking.status
            )}</td>

            <td>${escapeHtml(
              booking.payment_status
            )}</td>

            <td>${booking.created_at
              ? new Date(
                  booking.created_at
                ).toLocaleString("en-GB")
              : ""
            }</td>
          </tr>
        `;
      }

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

.card {
  background: white;
  padding: 25px;
  margin-bottom: 20px;
  border-radius: 12px;
  box-shadow: 0 2px 10px rgba(0,0,0,.08);
}

h1 {
  margin-top: 0;
}

h2 {
  margin-top: 0;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(auto-fit, minmax(180px, 1fr));
  gap: 15px;
}

.stat {
  background: #fafafa;
  padding: 18px;
  border-radius: 10px;
}

.stat strong {
  display: block;
  font-size: 26px;
  margin-top: 5px;
}

form {
  display: grid;
  gap: 15px;
}

label {
  font-weight: bold;
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
  padding: 13px 18px;
  border: none;
  border-radius: 7px;
  background: #111;
  color: white;
  font-size: 16px;
  cursor: pointer;
}

button:hover {
  opacity: .85;
}

table {
  width: 100%;
  border-collapse: collapse;
  min-width: 1000px;
}

th, td {
  border-bottom: 1px solid #ddd;
  padding: 10px;
  text-align: left;
}

th {
  background: #fafafa;
}

.table-wrap {
  overflow-x: auto;
}

.notice {
  padding: 12px;
  background: #eef8ee;
  border-radius: 7px;
  margin-bottom: 15px;
}

</style>

</head>

<body>

<div class="container">

<h1>🏸 Badminton Admin</h1>

<div class="card">

<h2>Session Details</h2>

<div class="notice">
Changes here are saved to Supabase and will be used by the WhatsApp bot.
</div>

<form method="POST"
action="/admin/session">

<div class="grid">

<div>
<label>Session Date</label>
<input
name="date"
value="${escapeHtml(
  badmintonSession.date
)}"
required>
</div>

<div>
<label>Start Time</label>
<input
name="startTime"
value="${escapeHtml(
  badmintonSession.startTime
)}"
required>
</div>

<div>
<label>End Time</label>
<input
name="endTime"
value="${escapeHtml(
  badmintonSession.endTime
)}"
required>
</div>

<div>
<label>Venue</label>
<input
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
value="${Number(
  badmintonSession.pricePerSpace
).toFixed(2)}"
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
value="${badmintonSession.totalCapacity}"
disabled>
</div>

</div>

<button type="submit">
Save Session Details
</button>

</form>

</div>

<div class="card">

<h2>Overview</h2>

<div class="grid">

<div class="stat">
Men remaining
<strong>${menRemaining}</strong>
</div>

<div class="stat">
Women remaining
<strong>${womenRemaining}</strong>
</div>

<div class="stat">
Paid bookings
<strong>${paidBookings.length}</strong>
</div>

<div class="stat">
Pending payments
<strong>${pendingBookings.length}</strong>
</div>

</div>

</div>

<div class="card">

<h2>Current Session</h2>

<p>
<strong>Date:</strong>
${escapeHtml(
  badmintonSession.date
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

<p>
<strong>Capacity:</strong>
${badmintonSession.totalCapacity}
</p>

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
<th>Payment</th>
<th>Created</th>

</tr>

</thead>

<tbody>

${bookingRows}

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
        "❌ Admin error:",
        error
      );

      res.status(500).send(
        "Admin dashboard error."
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
      const {
        date,
        startTime,
        endTime,
        venue,
        pricePerSpace,
        menCapacity,
        womenCapacity
      } = req.body;

      const price =
        Number(pricePerSpace);

      const men =
        Number(menCapacity);

      const women =
        Number(womenCapacity);

      if (
        !date ||
        !startTime ||
        !endTime ||
        !venue
      ) {
        return res
          .status(400)
          .send(
            "All session fields are required."
          );
      }

      if (
        !Number.isFinite(price) ||
        price < 0
      ) {
        return res
          .status(400)
          .send(
            "Invalid price."
          );
      }

      if (
        !Number.isInteger(men) ||
        men < 0
      ) {
        return res
          .status(400)
          .send(
            "Invalid men's capacity."
          );
      }

      if (
        !Number.isInteger(women) ||
        women < 0
      ) {
        return res
          .status(400)
          .send(
            "Invalid women's capacity."
          );
      }

      badmintonSession.date =
        date.trim();

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
// PRIVACY POLICY
// ============================================================

app.get(
  "/privacy",
  (req, res) => {
    res.send(`
<!DOCTYPE html>

<html>

<head>

<meta name="viewport"
content="width=device-width, initial-scale=1">

<title>Privacy Policy</title>

</head>

<body style="
font-family: Arial;
max-width: 800px;
margin: auto;
padding: 30px;
line-height: 1.6;
">

<h1>Privacy Policy</h1>

<p>
We use information provided through the Badminton Bot
to operate the service and organise badminton activities.
</p>

<h2>Information We Collect</h2>

<p>
We may collect your WhatsApp phone number, name,
booking information, attendee names and payment information
necessary to provide the service.
</p>

<h2>How We Use Information</h2>

<p>
We use this information to process bookings,
payments, availability and player information.
</p>

<h2>Sharing</h2>

<p>
We do not sell your personal information.
Information may be processed by service providers
necessary to operate the service, including WhatsApp/Meta,
Square, Supabase and hosting providers.
</p>

<h2>Data Retention</h2>

<p>
Information is retained only for as long as reasonably
necessary to operate the service or where there is a
legitimate legal or operational reason to retain it.
</p>

<h2>Your Rights</h2>

<p>
You may request access to or deletion of personal
information associated with your use of the service.
</p>

<h2>Contact</h2>

<p>
For privacy questions or deletion requests, contact:
</p>

<p>
<strong>hassan307@hotmail.co.uk</strong>
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

<meta name="viewport"
content="width=device-width, initial-scale=1">

<title>Payment Successful</title>

</head>

<body style="
font-family: Arial;
text-align: center;
padding: 50px;
">

<h1>✅ Payment successful</h1>

<p>
Your payment has been received.
</p>

<p>
Your booking confirmation will be
sent to you on WhatsApp.
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

<meta name="viewport"
content="width=device-width, initial-scale=1">

<title>Payment Cancelled</title>

</head>

<body style="
font-family: Arial;
text-align: center;
padding: 50px;
">

<h1>❌ Payment cancelled</h1>

<p>
Your payment was cancelled.
</p>

<p>
Your spaces have not been confirmed.
</p>

<p>
Return to WhatsApp if you would like
to try again.
</p>

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
// HEALTH CHECK
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
// HTML ESCAPE
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
  console.log(
    "🏸 Starting Badminton Bot..."
  );

  await loadSession();

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
        "💾 Supabase persistence enabled"
      );

      console.log(
        "💳 Square payment system enabled"
      );

      console.log(
        "📱 WhatsApp bot enabled"
      );

      console.log(
        "⚙️ Editable Admin session enabled"
      );
    }
  );
}

startServer();
