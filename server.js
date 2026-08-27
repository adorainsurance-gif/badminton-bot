require("dotenv").config();

const express = require("express");
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("🏸 Badminton Bot is running!");
});

// Meta webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Receive WhatsApp messages
app.post("/webhook", async (req, res) => {
  console.log("📩 WhatsApp message received");

  const message =
    req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (!message) {
    return res.sendStatus(200);
  }

  const from = message.from;

  console.log("Message from:", from);
  console.log("Message:", message.text?.body);

  // First automatic reply
  await sendWhatsAppMessage(
    from,
    "🏸 Welcome to Badminton Club!\n\n" +
    "What would you like to do?\n\n" +
    "1️⃣ Book a space\n" +
    "2️⃣ Check availability\n" +
    "3️⃣ Make a payment\n" +
    "4️⃣ My account"
  );

  res.sendStatus(200);
});

// Send message through WhatsApp
async function sendWhatsAppMessage(to, text) {
  const response = await fetch(
    `https://graph.facebook.com/v23.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: {
          body: text
        }
      })
    }
  );

  const data = await response.json();

  console.log("WhatsApp API response:", data);
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🏸 Badminton Bot running on port ${PORT}`);
});
