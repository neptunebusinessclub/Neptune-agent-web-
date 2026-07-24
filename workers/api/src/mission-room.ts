import { DurableObject } from "cloudflare:workers";

export interface MissionRoomEnv {
  APP_ENV: string;
}

export class MissionRoom extends DurableObject<MissionRoomEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/broadcast") {
      const payload = await request.text();
      this.broadcast(payload);
      return Response.json({ delivered: this.ctx.getWebSockets().length });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "CONNECTED", at: new Date().toISOString() }));

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (text === "ping") {
      socket.send(JSON.stringify({ type: "PONG", at: new Date().toISOString() }));
      return;
    }

    socket.send(JSON.stringify({ type: "ACK", at: new Date().toISOString() }));
  }

  webSocketError(socket: WebSocket, error: unknown): void {
    console.error("Mission room WebSocket error", error);
    socket.close(1011, "WebSocket error");
  }

  private broadcast(payload: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch (error) {
        console.error("Unable to broadcast mission event", error);
      }
    }
  }
}
