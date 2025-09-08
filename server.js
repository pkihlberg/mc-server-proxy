import net from "net";
import fetch from "node-fetch";
import 'dotenv/config';

const PORT = 25565;

// Railway API + Service Info
const PROJECT_ID = process.env.PROJECT_ID;
const ENVIRONMENT_ID = process.env.ENVIRONMENT_ID;
const SERVICE_ID = process.env.SERVICE_ID;
const RAILWAY_API_TOKEN = process.env.RAILWAY_API_TOKEN;

// MC server health check address (Node backup container)
const MC_SERVER_HEALTH = process.env.MC_SERVER_HEALTH || "http://mc-backup.pontuskihlberg.se:3000/health";

if (!PROJECT_ID || !ENVIRONMENT_ID || !SERVICE_ID || !RAILWAY_API_TOKEN) {
  console.error("[FATAL] Missing one of PROJECT_ID, ENVIRONMENT_ID, SERVICE_ID, or RAILWAY_API_TOKEN");
  process.exit(1);
}

const RAILWAY_API_URL = "https://backboard.railway.app/graphql/v2";

// Prevent multiple restarts
let restarting = false;
let lastWake = 0;
const COOLDOWN_MS = 60000;

// --- Utility: check if MC server is running ---
async function isServerRunning() {
  try {
    const user = process.env.HEALTH_USER || "admin";
    const pass = process.env.HEALTH_PASS || "secret";
    const auth = Buffer.from(`${user}:${pass}`).toString("base64");

    const res = await fetch(MC_SERVER_HEALTH, {
      headers: {
        "Authorization": `Basic ${auth}`,
      },
    });

    if (!res.ok) {
      console.error(`[HEALTH] Server health check failed: ${res.status}`);
      return false;
    }

    const data = await res.json();

    if (data.status === "active") console.log(`[HEALTH] Server health check completed: status ${res.status}`);

    return true;
  } catch (err) {
    console.error("[HEALTH] Error checking server:", err.message);
    return false; // If unreachable, assume not running
  }
}

// --- Fetch latest deployment ---
async function fetchLatestDeployment() {
  const query = `
    query deployments {
      deployments(
        first: 1
        input: {
          projectId: "${PROJECT_ID}"
          environmentId: "${ENVIRONMENT_ID}"
          serviceId: "${SERVICE_ID}"
        }
      ) {
        edges {
          node {
            id
            staticUrl
          }
        }
      }
    }
  `;

  const res = await fetch(RAILWAY_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RAILWAY_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  const data = await res.json();
  if (data.errors) {
    console.error("[ERROR] GraphQL returned errors:", data.errors);
    return null;
  }

  const edges = data.data.deployments.edges;
  if (!edges.length) return null;

  return edges[0].node;
}

// --- Restart deployment ---
async function restartDeployment(deploymentId) {
  const mutation = `
    mutation {
      deploymentRestart(id: "${deploymentId}")
    }
  `;

  const res = await fetch(RAILWAY_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RAILWAY_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: mutation }),
  });

  const data = await res.json();
  if (data.errors) {
    console.error("[ERROR] Restart failed:", data.errors);
    return false;
  }

  console.log("[WAKE] Restart triggered for deployment:", deploymentId);
  return true;
}

// --- Proxy server ---
const server = net.createServer((socket) => {
  socket.once("data", async (data) => {
    try {
      const username = data.toString("utf8").replace(/[^\w]/g, "");
      if (!username) {
        socket.end();
        return;
      }

      // Ignore MOTD pings
      if (username.includes("MCPingHost")) {
        console.log("[PING] Ignoring server list ping");
        socket.end();
        return;
      }

      // Check if server is already running
      if (await isServerRunning()) {
        console.log("[SKIP] MC server already running, no restart needed");
        socket.end("§eServer is already online, please join!\n");
        return;
      }

      // Check cooldown / restart lock
      if (restarting || Date.now() - lastWake < COOLDOWN_MS) {
        console.log("[SKIP] Server wake already in progress or cooldown active");
        socket.end("§eServer is starting... please wait.\n");
        return;
      }

      restarting = true;
      lastWake = Date.now();

      const deployment = await fetchLatestDeployment();
      if (!deployment) {
        console.error("[ERROR] No deployment found to restart.");
        socket.end("§cError: No deployment found.\n");
        restarting = false;
        return;
      }

      console.log("[INFO] Latest deployment:", deployment);

      const ok = await restartDeployment(deployment.id);
      if (ok) {
        socket.end("§eServer is starting... please try again in ~30s.\n");
      } else {
        socket.end("§cError starting server, try again later.\n");
      }

      // Reset lock after short cooldown
      setTimeout(() => {
        restarting = false;
      }, COOLDOWN_MS);

    } catch (e) {
      console.error("[ERROR] Handshake:", e.message);
      socket.end();
    }
  });
});

server.listen(PORT, () => {
  console.log(`[PROXY] Listening on 0.0.0.0:${PORT}`);
});
