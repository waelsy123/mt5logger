import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { bearerAuth } from "hono/bearer-auth";

const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.error("FATAL: API_KEY environment variable is required");
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "3000", 10);

const app = new Hono();

app.use("*", logger());

// Health check — no auth
app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Webhook — bearer auth required
app.use("/webhook", bearerAuth({ token: API_KEY }));

app.post("/webhook", async (c) => {
  try {
    const payload = await c.req.json();

    if (!payload.event_type) {
      return c.json({ error: "Missing required field: event_type" }, 400);
    }

    if (payload.event_type !== "account" && (!payload.ticket || !payload.symbol)) {
      return c.json(
        { error: "Missing required fields: ticket, symbol" },
        400
      );
    }

    console.log(
      JSON.stringify({
        logged_at: new Date().toISOString(),
        ...payload,
      })
    );

    return c.json({ status: "received", ticket: payload.ticket }, 200);
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  console.error("Unhandled error:", err.message);
  return c.json({ error: "Internal server error" }, 500);
});

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`MT5 Trade Logger listening on port ${info.port}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  server.close(() => process.exit(0));
});
