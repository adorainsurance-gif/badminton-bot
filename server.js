require("dotenv").config();

const express = require("express");

const app = express();
app.use(express.json());


// ============================================================
// PRIVACY POLICY
// ============================================================

app.get("/privacy-policy", (req, res) => {
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

        h1, h2 {
          color: #111;
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
        When you use Badminton Bot, we may process information that
        you voluntarily provide, including your WhatsApp phone number,
        name, messages and information relating to your badminton activities.
      </p>

      <h2>How We Use Your Information</h2>

      <p>
        We use this information to provide, operate and improve the
        Badminton Bot service, including responding to your requests
        and helping organise badminton activities.
      </p>

      <h2>Sharing of Information</h2>

      <p>
        We do not sell your personal information.
        Information may be processed by service providers necessary
        to operate the bot, including WhatsApp/Meta and our hosting
        and software providers.
      </p>

      <h2>Data Retention</h2>

      <p>
        We retain information only for as long as reasonably necessary
        to provide the service or where we have a legitimate legal or
        operational reason to retain it.
      </p>

      <h2>Your Rights</h2>

      <p>
        You may request access to or deletion of personal information
        associated with your use of the Badminton Bot.
      </p>

      <h2>Contact</h2>

      <p>
        If you have questions about this Privacy Policy or want to
        request deletion of your information, contact:
      </p>

      <p>
        <strong>hassan307@hotmail.co.uk</strong>
      </p>

      <p>
        <strong>Last updated:</strong> 3 September 2026
      </p>

    </body>
    </html>
  `);
});


// ============================================================
// CONFIGURATION
// ============================================================

const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;


// ============================================================
// TEMPORARY DATABASE
// ============================================================
//
// IMPORTANT:
// This is still temporary.
// Later we will replace this with Supabase.
//
// Each phone number has a player record.
// ============================================================

const players = new Map();


// ============================================================
// SESSION SETTINGS
// ============================================================
//
// For now these are manually set here.
// Later your admin panel will control these values.
//
// 24 total spaces
// 12 men
// 12 women
// ============================================================

const badmintonSession = {

  date: "Saturday 12 September",

  startTime: "7:00 PM",

  endTime: "9:00 PM",

  venue: "Peckham Sports Centre",

  totalSpaces: 24,

  menCapacity: 12,

  womenCapacity: 12,

  pricePerSpace: 8

};


// ============================================================
// BOOKING STATE
// ============================================================
//
// This lets the bot remember where each customer is in
// the booking process.
//
// Example:
//
// CHOOSING_SESSION
// CHOOSING_GENDER
// CHOOSING_QUANTITY
// ENTERING_NAMES
// CONFIRMING_BOOKING
// ============================================================

const bookingStates = new Map();


// ============================================================
// HOME / HEALTH CHECK
// ============================================================

app.get("/", (req, res) => {

  res.status(200).send("🏸 Badminton Bot is running!");

});


// ============================================================
// META WEBHOOK VERIFICATION
// ============================================================

app.get("/webhook", (req, res) => {

  const mode = req.query["hub.mode"];

  const token = req.query["hub.verify_token"];

  const challenge = req.query["hub.challenge"];


  if (mode === "subscribe" && token === VERIFY_TOKEN) {

    console.log("✅ Webhook verified");

    return res.status(200).send(challenge);

  }


  console.log("❌ Webhook verification failed");

  return res.sendStatus(403);

});


// ============================================================
// RECEIVE WHATSAPP MESSAGES
// ============================================================

app.post("/webhook", async (req, res) => {

  // Tell Meta immediately that we received the message.
  res.sendStatus(200);


  try {

    const value =
      req.body?.entry?.[0]?.changes?.[0]?.value;

    const message =
      value?.messages?.[0];


    if (!message) return;


    const from =
      message.from;


    const text =
      message?.text?.body?.trim() || "";


    if (!text) return;


    console.log(
      `📩 Message from ${from}: ${text}`
    );


    const reply =
      handleMessage(from, text);


    if (reply) {

      await sendWhatsAppMessage(
        from,
        reply
      );

    }


  } catch (error) {

    console.error(
      "❌ Webhook error:",
      error
    );

  }

});


// ============================================================
// MAIN BOT LOGIC
// ============================================================

function handleMessage(phone, text) {

  const command =
    text.toLowerCase().trim();


  // ----------------------------------------------------------
  // CANCEL CURRENT BOOKING PROCESS
  // ----------------------------------------------------------

  if (
    command === "cancel" ||
    command === "stop"
  ) {

    bookingStates.delete(phone);

    return (
      "❌ *Booking cancelled.*\n\n" +
      "No booking has been made.\n\n" +
      "Reply *menu* to start again."
    );

  }


  // ----------------------------------------------------------
  // MAIN MENU
  // ----------------------------------------------------------

  if (
    command === "hi" ||
    command === "hello" ||
    command === "menu" ||
    command === "start"
  ) {

    bookingStates.delete(phone);

    return (

      "🏸 *Badminton Bot*\n\n" +

      "What would you like to do?\n\n" +

      "1️⃣ Book a space\n" +

      "2️⃣ Check availability\n" +

      "3️⃣ My booking\n" +

      "4️⃣ My details\n" +

      "5️⃣ Rankings\n\n" +

      "Reply with the number or option."

    );

  }


  // ----------------------------------------------------------
  // BOOK A SPACE
  // ----------------------------------------------------------

  if (
    command === "1" ||
    command === "book" ||
    command === "booking" ||
    command === "book a space"
  ) {

    bookingStates.set(phone, {

      step: "CHOOSING_SESSION"

    });


    return showSession();

  }


  // ----------------------------------------------------------
  // CONTINUE FROM SESSION
  // ----------------------------------------------------------

  if (
    command === "yes" ||
    command === "continue"
  ) {

    const state =
      bookingStates.get(phone);


    if (
      state?.step === "CHOOSING_SESSION"
    ) {

      state.step =
        "CHOOSING_GENDER";


      bookingStates.set(
        phone,
        state
      );


      return showGenderSelection();

    }

  }


  // ----------------------------------------------------------
  // GENDER SELECTION
  // ----------------------------------------------------------

  if (
    command === "men" ||
    command === "male" ||
    command === "m"
  ) {

    return chooseGender(
      phone,
      "men"
    );

  }


  if (
    command === "women" ||
    command === "female" ||
    command === "w"
  ) {

    return chooseGender(
      phone,
      "women"
    );

  }


  // ----------------------------------------------------------
  // QUANTITY
  // ----------------------------------------------------------

  if (
    command === "1" ||
    command === "2" ||
    command === "3"
  ) {

    const state =
      bookingStates.get(phone);


    if (
      state?.step === "CHOOSING_QUANTITY"
    ) {

      const quantity =
        Number(command);


      state.quantity =
        quantity;


      state.attendees =
        [];


      state.currentAttendee =
        1;


      state.step =
        "ENTERING_NAMES";


      bookingStates.set(
        phone,
        state
      );


      return askForAttendeeName(
        state.currentAttendee,
        quantity
      );

    }

  }


  // ----------------------------------------------------------
  // ATTENDEE NAME
  // ----------------------------------------------------------

  const state =
    bookingStates.get(phone);


  if (
    state?.step === "ENTERING_NAMES"
  ) {

    return saveAttendeeName(
      phone,
      text
    );

  }


  // ----------------------------------------------------------
  // FINAL CONFIRMATION
  // ----------------------------------------------------------

  if (
    state?.step === "CONFIRMING_BOOKING"
  ) {

    if (
      command === "yes" ||
      command === "confirm"
    ) {

      return confirmBookingBeforePayment(
        phone
      );

    }


    if (
      command === "no" ||
      command === "edit"
    ) {

      bookingStates.delete(phone);

      return (
        "✏️ Let's start the booking again.\n\n" +
        "Reply *book* to begin."
      );

    }

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

    return getAvailability();

  }


  // ----------------------------------------------------------
  // MY BOOKING
  // ----------------------------------------------------------

  if (
    command === "3" ||
    command === "my booking"
  ) {

    return getMyBooking(phone);

  }


  // ----------------------------------------------------------
  // MY DETAILS
  // ----------------------------------------------------------

  if (
    command === "4" ||
    command === "my details" ||
    command === "details"
  ) {

    const player =
      players.get(phone);


    if (!player) {

      return (
        "👤 I don't have your details yet.\n\n" +
        "Please enter your full name."
      );

    }


    return (

      "👤 *Your details*\n\n" +

      `Name: ${player.name}\n` +

      `Points: ${player.points || 0} pts\n` +

      `Payment: ${
        player.paid
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

    return getRanking();

  }


  // ----------------------------------------------------------
  // UNKNOWN MESSAGE
  // ----------------------------------------------------------

  return (

    "🏸 I didn't understand that.\n\n" +

    "Reply *menu* to see what I can do."

  );

}


// ============================================================
// SHOW SESSION
// ============================================================

function showSession() {

  return (

    "🏸 *Book a Space*\n\n" +

    "Your next badminton session is:\n\n" +

    `📅 *${badmintonSession.date}*\n` +

    `🕖 *${badmintonSession.startTime} - ${badmintonSession.endTime}*\n` +

    `📍 *${badmintonSession.venue}*\n\n` +

    "Would you like to continue?\n\n" +

    "Reply *YES* to continue.\n" +

    "Reply *NO* to return to the menu."

  );

}


// ============================================================
// GENDER SELECTION
// ============================================================

function showGenderSelection() {

  return (

    "👥 *Choose your space allocation*\n\n" +

    `👨 Men: *${getRemainingSpaces("men")} spaces available*\n` +

    `👩 Women: *${getRemainingSpaces("women")} spaces available*\n\n` +

    "Please reply:\n\n" +

    "*MEN* 👨\n" +

    "*WOMEN* 👩"

  );

}


// ============================================================
// CHOOSE GENDER
// ============================================================

function chooseGender(phone, gender) {

  const state =
    bookingStates.get(phone);


  if (!state) {

    return (
      "Please start by replying *BOOK*."
    );

  }


  const available =
    getRemainingSpaces(gender);


  if (available <= 0) {

    return (

      `❌ There are currently no ${gender} spaces available.\n\n` +

      "Reply *menu* to return to the main menu."

    );

  }


  state.gender =
    gender;


  state.step =
    "CHOOSING_QUANTITY";


  bookingStates.set(
    phone,
    state
  );


  const max =
    Math.min(3, available);


  return (

    `👤 *${capitalize(gender)} spaces*\n\n` +

    `There are *${available} spaces remaining*.\n\n` +

    "How many spaces would you like?\n\n" +

    (max >= 1 ? "1️⃣ 1 space\n" : "") +

    (max >= 2 ? "2️⃣ 2 spaces\n" : "") +

    (max >= 3 ? "3️⃣ 3 spaces\n" : "") +

    "\n⚠️ Maximum 3 spaces per booking."

  );

}


// ============================================================
// ASK FOR ATTENDEE NAME
// ============================================================

function askForAttendeeName(
  attendeeNumber,
  total
) {

  return (

    `👤 *Attendee ${attendeeNumber} of ${total}*\n\n` +

    "Please enter their *full name*.\n\n" +

    "Example: John Smith"

  );

}


// ============================================================
// SAVE ATTENDEE NAME
// ============================================================

function saveAttendeeName(phone, text) {

  const state =
    bookingStates.get(phone);


  // Basic full-name validation.
  if (
    !isValidFullName(text)
  ) {

    return (

      "❌ Please enter the attendee's *full name*.\n\n" +

      "Example:\n" +

      "*John Smith*"

    );

  }


  state.attendees.push(
    text.trim()
  );


  if (
    state.currentAttendee <
    state.quantity
  ) {

    state.currentAttendee++;


    bookingStates.set(
      phone,
      state
    );


    return askForAttendeeName(
      state.currentAttendee,
      state.quantity
    );

  }


  // All names collected.

  state.step =
    "CONFIRMING_BOOKING";


  bookingStates.set(
    phone,
    state
  );


  return getBookingConfirmation(
    state
  );

}


// ============================================================
// VALIDATE FULL NAME
// ============================================================

function isValidFullName(name) {

  const cleaned =
    name.trim();


  // Require at least two words.
  const words =
    cleaned.split(/\s+/);


  if (
    words.length < 2
  ) {

    return false;

  }


  // Allow normal letters, accents, apostrophes and hyphens.
  return /^[a-zA-ZÀ-ÿ' -]{2,80}$/.test(
    cleaned
  );

}


// ============================================================
// BOOKING CONFIRMATION
// ============================================================

function getBookingConfirmation(state) {

  const total =
    state.quantity *
    badmintonSession.pricePerSpace;


  const attendeeList =
    state.attendees
      .map(
        (name, index) =>
          `${index + 1}. ${name}`
      )
      .join("\n");


  return (

    "🏸 *PLEASE CONFIRM YOUR BOOKING*\n\n" +

    `📅 ${badmintonSession.date}\n` +

    `🕖 ${badmintonSession.startTime} - ${badmintonSession.endTime}\n` +

    `📍 ${badmintonSession.venue}\n\n` +

    `👥 *${state.quantity} space${
      state.quantity > 1 ? "s" : ""
    }*\n` +

    `👤 Allocation: *${capitalize(state.gender)}*\n\n` +

    "*Attendees:*\n" +

    `${attendeeList}\n\n` +

    `💷 *Total: £${total.toFixed(2)}*\n\n` +

    "Reply *YES* to confirm and continue to payment.\n\n" +

    "Reply *NO* to cancel."

  );

}


// ============================================================
// PAYMENT STAGE
// ============================================================
//
// Stripe will be connected here next.
//
// IMPORTANT:
// We do NOT mark the spaces as booked here.
//
// Stripe must confirm payment first.
// ============================================================

function confirmBookingBeforePayment(phone) {

  const state =
    bookingStates.get(phone);


  if (!state) {

    return (
      "❌ Your booking session has expired.\n\n" +
      "Reply *BOOK* to start again."
    );

  }


  const available =
    getRemainingSpaces(
      state.gender
    );


  if (
    available < state.quantity
  ) {

    bookingStates.delete(phone);


    return (

      "❌ Unfortunately, there aren't enough spaces left.\n\n" +

      `Only *${available}* ${
        state.gender
      } space${
        available === 1 ? "" : "s"
      } remain.\n\n` +

      "Please reply *BOOK* to try again."

    );

  }


  const total =
    state.quantity *
    badmintonSession.pricePerSpace;


  // ----------------------------------------------------------
  // TEMPORARY PAYMENT RESPONSE
  // ----------------------------------------------------------
  //
  // Stripe payment link will replace this.
  // ----------------------------------------------------------

  return (

    "💷 *Payment required*\n\n" +

    `Your total is *£${total.toFixed(2)}*.\n\n` +

    "Stripe payment will be connected here.\n\n" +

    "⚠️ *Your spaces are NOT confirmed until payment is successfully completed.*"

  );

}


// ============================================================
// AVAILABILITY
// ============================================================

function getAvailability() {

  const menRemaining =
    getRemainingSpaces("men");


  const womenRemaining =
    getRemainingSpaces("women");


  return (

    "🏸 *Session Availability*\n\n" +

    `📅 ${badmintonSession.date}\n` +

    `🕖 ${badmintonSession.startTime} - ${badmintonSession.endTime}\n` +

    `📍 ${badmintonSession.venue}\n\n` +

    `👨 Men: *${menRemaining} spaces remaining*\n` +

    `👩 Women: *${womenRemaining} spaces remaining*\n\n` +

    `👥 Total: *${
      menRemaining + womenRemaining
    } spaces remaining*`

  );

}


// ============================================================
// CALCULATE REMAINING SPACES
// ============================================================

function getRemainingSpaces(gender) {

  const capacity =
    gender === "men"
      ? badmintonSession.menCapacity
      : badmintonSession.womenCapacity;


  let booked = 0;


  for (
    const player of players.values()
  ) {

    if (
      player.booking &&
      player.booking.gender === gender &&
      player.booking.sessionDate === badmintonSession.date &&
      player.booking.paymentStatus === "paid"
    ) {

      booked +=
        player.booking.quantity;

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

function getMyBooking(phone) {

  const player =
    players.get(phone);


  if (
    !player?.booking
  ) {

    return (

      "🏸 *My Booking*\n\n" +

      "You don't currently have a booking.\n\n" +

      "Reply *BOOK* to book a space."

    );

  }


  const booking =
    player.booking;


  const attendeeList =
    booking.attendees
      .map(
        (name, index) =>
          `${index + 1}. ${name}`
      )
      .join("\n");


  return (

    "🏸 *Your Booking*\n\n" +

    `📅 ${booking.sessionDate}\n` +

    `🕖 ${booking.startTime} - ${booking.endTime}\n` +

    `📍 ${booking.venue}\n\n` +

    `👤 ${capitalize(booking.gender)}\n` +

    `👥 ${booking.quantity} space${
      booking.quantity > 1 ? "s" : ""
    }\n\n` +

    "*Attendees:*\n" +

    attendeeList +

    "\n\n" +

    `💷 Payment: ${
      booking.paymentStatus === "paid"
        ? "Paid ✅"
        : "Not paid ❌"
    }`

  );

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

          `${index + 1}. ${
            player.name
          } — ${
            player.points || 0
          } pts`

      )

      .join("\n")

  );

}


// ============================================================
// CAPITALIZE
// ============================================================

function capitalize(text) {

  return text
    .charAt(0)
    .toUpperCase() +
    text.slice(1);

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

    console.log(
      "Message would have been:",
      message
    );

    return;

  }


  const url =
    `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;


  const response =
    await fetch(
      url,
      {

        method: "POST",

        headers: {

          "Authorization":
            `Bearer ${WHATSAPP_TOKEN}`,

          "Content-Type":
            "application/json"

        },

        body:
          JSON.stringify({

            messaging_product:
              "whatsapp",

            to: to,

            type: "text",

            text: {

              body: message

            }

          })

      }
    );


  const data =
    await response.json();


  if (
    !response.ok
  ) {

    console.error(
      "❌ WhatsApp API error:",
      data
    );

    return;

  }


  console.log(
    "✅ WhatsApp message sent"
  );

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

  }
);
