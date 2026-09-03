require("dotenv").config();

const express = require("express");

const app = express();
app.use(express.json());app.get("/privacy-policy", (req, res) => {
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
        h1, h2 { color: #111; }
      </style>
    </head>
    <body>
      <h1>Privacy Policy</h1>

      <p><strong>Badminton Bot</strong> is a WhatsApp-based service designed to help users organise and manage badminton activities.</p>

      <h2>Information We Collect</h2>
      <p>When you use Badminton Bot, we may process information that you voluntarily provide, including your WhatsApp phone number, name, messages and information relating to your badminton activities.</p>

      <h2>How We Use Your Information</h2>
      <p>We use this information to provide, operate and improve the Badminton Bot service, including responding to your requests and helping organise badminton activities.</p>

      <h2>Sharing of Information</h2>
      <p>We do not sell your personal information. Information may be processed by service providers that are necessary to operate the bot, including WhatsApp/Meta and our hosting and software providers.</p>

      <h2>Data Retention</h2>
      <p>We retain information only for as long as reasonably necessary to provide the service or where we have a legitimate legal or operational reason to retain it.</p>

      <h2>Your Rights</h2>
      <p>You may request access to or deletion of personal information associated with your use of Badminton Bot.</p>

      <h2>Contact</h2>
      <p>If you have questions about this Privacy Policy or want to request deletion of your information, contact:</p>
      <p><strong>hassan307@hotmail.co.uk</strong></p>

      <p><strong>Last updated:</strong> 3 September 2026</p>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Temporary data.
// We will replace this with a real database later.
const players = new Map();

const sessions = {
  "court 1": { available: true },
  "court 2": { available: true },
  "court 3": { available: false },
  "court 4": { available: true }
};

// HOME / HEALTH CHECK
app.get("/", (req, res) => {
  res.status(200).send("🏸 Badminton Bot is running!");
});

// META WEBHOOK VERIFICATION
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

// RECEIVE WHATSAPP MESSAGES
app.post("/webhook", async (req, res) => {
  // Tell Meta we received the message
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const from = message.from;
    const text = message?.text?.body?.trim() || "";

    if (!text) return;

    console.log(`📩 Message from ${from}: ${text}`);

    const reply = handleMessage(from, text);

    if (reply) {
      await sendWhatsAppMessage(from, reply);
    }

  } catch (error) {
    console.error("❌ Webhook error:", error);
  }
});

// BOT LOGIC
function handleMessage(phone, text) {

  const command = text.toLowerCase();

  // MENU
  if (
    command === "hi" ||
    command === "hello" ||
    command === "menu"
  ) {
    return (
      "🏸 *Badminton Bot*\n\n" +
      "What would you like to do?\n\n" +
      "1️⃣ Book a space\n" +
      "2️⃣ Check Availability \n" +
      "3️⃣ My Booking\n" +
      "4️⃣ Help\n" +
      "Reply with the option or word."
    );
  }

 // BOOK A SPACE
if (
  command === "1" ||
  command === "book" ||
  command === "booking"
) {
  return (
    "🏸 *Book a Space*\n\n" +
    "The next badminton session is:\n\n" +
    "📅 Thursday\n" +
    "🕖 7:00 PM - 9:00 PM\n\n" +
    "Would you like to book a space for this session?\n\n" +
    "Reply *YES* to continue or *NO* to go back to the menu."
  );
}

  // BOOKING
  if (
    command === "2" ||
    command === "book" ||
    command === "booking"
  ) {
    return (
      "🏸 *Book a space*\n\n" +
      "Available spaces are:\n\n" +
      getAvailableSpaceNames() +
      "\n\nReply with the court you want, e.g. *Court 1*."
    );
  }

  // PAYMENT
  if (
    command === "3" ||
    command === "payment" ||
    command === "pay"
  ) {
    const player = players.get(phone);

    if (player?.paid) {
      return "💷 Your payment status is *PAID* ✅";
    }

    return (
      "💷 Your payment status is currently *NOT PAID* ❌\n\n" +
      "The payment link will be connected here."
    );
  }

  // RANKINGS
  if (
    command === "4" ||
    command === "ranking" ||
    command === "rankings"
  ) {
    return getRanking();
  }

  // DETAILS
  if (
    command === "5" ||
    command === "my details" ||
    command === "details"
  ) {
    const player = players.get(phone);

    if (!player) {
      return (
        "👤 I don't have your details yet.\n\n" +
        "Please send me your name."
      );
    }

    return (
      "👤 *Your details*\n\n" +
      `Name: ${player.name}\n` +
      `Points: ${player.points}\n` +
      `Payment: ${player.paid ? "Paid ✅" : "Not paid ❌"}`
    );
  }

  // COURT SELECTION
  if (command.includes("court")) {

    const court = command;

    if (!sessions[court]) {
      return (
        "❌ I couldn't find that court.\n\n" +
        "Please choose an available court."
      );
    }

    if (!sessions[court].available) {
      return `❌ ${court} is currently unavailable.`;
    }

    return (
      `🏸 ${court} is available.\n\n` +
      "Your booking system will confirm the booking here once we connect the database and payment system."
    );
  }

  // SAVE PLAYER NAME
  if (/^[a-zA-ZÀ-ÿ' -]{2,50}$/.test(text)) {

    players.set(phone, {
      name: text,
      points: players.get(phone)?.points || 0,
      paid: players.get(phone)?.paid || false
    });

    return (
      `Thanks, ${text}! 👋\n\n` +
      "I've saved your player details.\n\n" +
      "Reply *menu* to see what I can do."
    );
  }

  // UNKNOWN MESSAGE
  return (
    "🏸 I didn't understand that.\n\n" +
    "Reply *menu* to see what I can do."
  );
}

// AVAILABLE SPACES
function getSpaces() {

  const available = Object.entries(sessions)
    .filter(([, session]) => session.available)
    .map(([name]) => name);

  if (available.length === 0) {
    return "🏸 There are currently no spaces available.";
  }

  return (
    "🏸 *Available spaces*\n\n" +
    available.map(name => `✅ ${name}`).join("\n")
  );
}

function getAvailableSpaceNames() {

  const available = Object.entries(sessions)
    .filter(([, session]) => session.available)
    .map(([name]) => `✅ ${name}`);

  return available.length
    ? available.join("\n")
    : "❌ No spaces currently available.";
}

// RANKINGS
function getRanking() {

  const ranked = [...players.values()]
    .sort((a, b) => b.points - a.points)
    .slice(0, 10);

  if (ranked.length === 0) {
    return "🏆 No players have been added to the ranking yet.";
  }

  return (
    "🏆 *Player Rankings*\n\n" +
    ranked
      .map(
        (player, index) =>
          `${index + 1}. ${player.name} — ${player.points} pts`
      )
      .join("\n")
  );
}

// SEND WHATSAPP MESSAGE
async function sendWhatsAppMessage(to, message) {

  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {

    console.log("⚠️ WhatsApp credentials are not configured.");
    console.log("Message would have been:", message);

    return;
  }

  const url =
    `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {

    method: "POST",

    headers: {
      "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },

    body: JSON.stringify({

      messaging_product: "whatsapp",

      to: to,

      type: "text",

      text: {
        body: message
      }

    })

  });

  const data = await response.json();

  if (!response.ok) {
    console.error("❌ WhatsApp API error:", data);
    return;
  }

  console.log("✅ WhatsApp message sent");
}

// START SERVER
app.listen(PORT, "0.0.0.0", () => {

  console.log(
    `🏸 Badminton Bot running on port ${PORT}`
  );

});
