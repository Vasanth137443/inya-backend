const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const cors = require("cors");
const shortid = require("shortid");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("."));

const MOCK_BASE = "http://localhost:3001"; // json-server
const sessions = {}; // store state per user/session

// Helpers
function maskEmail(email) {
  if (!email) return "";
  const [local, domain] = email.split("@");
  return local[0] + "*****@" + domain.split(".")[0].slice(0, 1) + "***.com";
}
function maskPhone(phone) {
  if (!phone) return "";
  return phone.slice(0, -4).replace(/\d/g, "x") + phone.slice(-4);
}
function normalizeCarrierStatus(raw) {
  if (!raw) return "created";
  raw = raw.toLowerCase();
  if (raw.includes("pick")) return "picked_up";
  if (raw.includes("transit")) return "in_transit";
  if (raw.includes("out for")) return "out_for_delivery";
  if (raw.includes("deliver")) return "delivered";
  if (raw.includes("exception") || raw.includes("delay")) return "exception";
  return "in_transit";
}
function detectIntent(text) {
  text = (text || "").toLowerCase();
  if (/track/i.test(text)) return "track_order";
  if (/refund status/i.test(text)) return "refund_status";
  if (/refund/i.test(text)) return "initiate_refund";
  if (/complaint|complain/i.test(text)) return "register_complaint";
  if (/return/i.test(text)) return "create_return";
  if (/agent|human|help/i.test(text)) return "agent_handoff";
  if (/hi|hello|hey/i.test(text)) return "greeting";
  if (/bye|thank/i.test(text)) return "goodbye";
  return "fallback";
}
function extractOrderId(text) {
  const m = text.match(/ord[0-9]+/i);
  return m ? m[0].toUpperCase() : null;
}
function extractRefundId(text) {
  const m = text.match(/rfd[-]?[A-Za-z0-9]+/i);
  return m ? m[0].toUpperCase() : null;
}

// Chat endpoint
app.post("/chat", async (req, res) => {
  const { message, session = "default" } = req.body;
  const intent = detectIntent(message);
  if (!sessions[session]) sessions[session] = { intent: null, retries: 0, data: {} };
  const ctx = sessions[session];

  try {
    // Handle greetings & goodbye
    if (intent === "greeting") return res.json({ reply: "Hi! I can help with tracking, refunds, returns, and complaints. What would you like to do?" });
    if (intent === "goodbye") return res.json({ reply: "Thanks for chatting. Have a great day!" });
    if (intent === "agent_handoff") return res.json({ reply: "Connecting you to a human agent... (simulated handoff)" });

    // If continuing a flow
    if (ctx.intent && !intent) {
      if (ctx.intent === "initiate_refund" && !ctx.data.order_id) {
        ctx.data.order_id = extractOrderId(message);
        if (!ctx.data.order_id) {
          ctx.retries++;
          if (ctx.retries > 1) {
            ctx.intent = null;
            return res.json({ reply: "I couldn’t capture a valid Order ID. Let me connect you to an agent." });
          }
          return res.json({ reply: "That doesn’t look like a valid Order ID. Please try again (e.g., ORD1001)." });
        }
        intent = "initiate_refund"; // continue flow
      }
      if (ctx.intent === "register_complaint" && !ctx.data.order_id) {
        ctx.data.order_id = extractOrderId(message);
        if (!ctx.data.order_id) {
          ctx.retries++;
          if (ctx.retries > 1) {
            ctx.intent = null;
            return res.json({ reply: "I couldn’t capture the Order ID. Escalating to an agent." });
          }
          return res.json({ reply: "Please share a valid Order ID like ORD1001." });
        }
        intent = "register_complaint";
      }
    }

    // TRACK ORDER
    if (intent === "track_order") {
      const order_id = extractOrderId(message);
      if (!order_id) {
        ctx.intent = "track_order";
        return res.json({ reply: "Sure, please share your Order ID (e.g., ORD1001)." });
      }
      const or = await fetch(`${MOCK_BASE}/orders?order_id=${order_id}`).then(r => r.json());
      if (!or.length) return res.json({ reply: `I couldn’t find ${order_id}. Please double-check.` });
      const order = or[0];
      if (!order.tracking_id) {
        return res.json({ reply: `Order ${order.order_id} is currently *${order.status}*. No tracking yet. Summary: waiting for shipment.` });
      }
      const sh = await fetch(`${MOCK_BASE}/shipments?tracking_id=${order.tracking_id}`).then(r => r.json());
      if (!sh.length) return res.json({ reply: `Tracking info unavailable for ${order_id}. Last event: ${order.last_event}.` });
      const shipment = sh[0];
      const norm = normalizeCarrierStatus(shipment.status);
      return res.json({ reply: `Order ${order_id} is *${norm.replace(/_/g, " ")}*. ETA: ${shipment.eta_iso || "unknown"}. Summary: Order ${order_id}, status ${norm}.` });
    }

    // INITIATE REFUND
    if (intent === "initiate_refund") {
      const order_id = extractOrderId(message) || ctx.data.order_id;
      if (!order_id) {
        ctx.intent = "initiate_refund"; ctx.retries = 0; ctx.data = {};
        return res.json({ reply: "Sure. Please provide your Order ID to start a refund." });
      }
      const or = await fetch(`${MOCK_BASE}/orders?order_id=${order_id}`).then(r => r.json());
      if (!or.length) return res.json({ reply: `I couldn’t find ${order_id}.` });
      const order = or[0];
      if (!["shipped", "delivered"].includes(order.status)) return res.json({ reply: `Order ${order_id} is *${order.status}*. Refund not available yet.` });
      const refundId = "RFD-" + shortid.generate().toUpperCase();
      const amount = order.items.reduce((s, i) => s + (i.price || 0), 0);
      const refundObj = { refund_id: refundId, order_id, amount, sla_days: 5, status: "initiated", created_at: new Date().toISOString() };
      await fetch(`${MOCK_BASE}/refunds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(refundObj) });
      ctx.intent = null;
      return res.json({ reply: `Refund created: ${refundId}, amount ₹${amount}, SLA 5 days. Summary: Refund for ${order_id}.` });
    }

    // REFUND STATUS
    if (intent === "refund_status") {
      const refundId = extractRefundId(message);
      if (!refundId) return res.json({ reply: "Please provide a Refund ID (e.g., RFD-XXXX)." });
      const rf = await fetch(`${MOCK_BASE}/refunds?refund_id=${refundId}`).then(r => r.json());
      if (!rf.length) return res.json({ reply: `Refund ${refundId} not found.` });
      const r = rf[0];
      return res.json({ reply: `Refund ${r.refund_id} is *${r.status}*. Amount ₹${r.amount}, SLA ${r.sla_days} days. Summary: refund status checked.` });
    }

    // REGISTER COMPLAINT
    if (intent === "register_complaint") {
      const order_id = extractOrderId(message) || ctx.data.order_id;
      if (!order_id) {
        ctx.intent = "register_complaint"; ctx.retries = 0; ctx.data = {};
        return res.json({ reply: "Please share your Order ID to register a complaint." });
      }
      const existing = await fetch(`${MOCK_BASE}/complaints?order_id=${order_id}`).then(r => r.json());
      if (existing.length) {
        return res.json({ reply: `You already have a complaint: ${existing[0].ticket_id}. Do you want to escalate?` });
      }
      const ticketId = "TCK-" + shortid.generate().toUpperCase();
      const complaint = { ticket_id: ticketId, order_id, description: message, priority: "Normal", sla_hours: 72, created_at: new Date().toISOString() };
      await fetch(`${MOCK_BASE}/complaints`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(complaint) });
      ctx.intent = null;
      return res.json({ reply: `Complaint registered: ${ticketId}, SLA 72h. Summary: complaint created.` });
    }

    // CREATE RETURN
    if (intent === "create_return") {
      const order_id = extractOrderId(message);
      if (!order_id) return res.json({ reply: "Please share your Order ID to start a return." });
      const or = await fetch(`${MOCK_BASE}/orders?order_id=${order_id}`).then(r => r.json());
      if (!or.length) return res.json({ reply: `Order ${order_id} not found.` });
      const order = or[0];
      const placed = new Date(order.placed_at);
      const daysSince = Math.floor((Date.now() - placed.getTime()) / (1000 * 60 * 60 * 24));
      if (daysSince > 14) return res.json({ reply: `Return window expired (${daysSince} days). Summary: return rejected.` });
      const returnId = "RTN-" + shortid.generate().toUpperCase();
      const ret = { return_id: returnId, order_id, reason: "Customer requested return", pickup_window: "2025-09-15 10:00-14:00", status: "pickup_scheduled" };
      await fetch(`${MOCK_BASE}/returns`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ret) });
      return res.json({ reply: `Return created: ${returnId}, pickup on ${ret.pickup_window}. Summary: return scheduled.` });
    }

    // fallback
    return res.json({ reply: "Sorry, I didn’t understand. I can help with: track order, refund, complaint, return, or agent handoff." });

  } catch (err) {
    console.error(err);
    return res.json({ reply: "Something went wrong. Let me connect you to an agent." });
  }
});

const PORT = 4000;
app.listen(PORT, () => console.log(`Chat server running on ${PORT}. Mock API at http://localhost:3001`));
