// 桌宠独立联调用的 mock WebSocket 服务。
// 用法：node test/mock-server.mjs
import { WebSocketServer } from "ws";

const port = Number(process.env.PORT || 18701);
const wss = new WebSocketServer({ host: "127.0.0.1", port });
console.log(`mock DSH ws://127.0.0.1:${port}`);

wss.on("connection", (ws) => {
  console.log("[mock] PET CONNECTED");
  ws.on("message", (data) => {
    console.log("[mock] from pet:", String(data));
    let m;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (m.type === "balance") {
      setTimeout(() => ws.send(JSON.stringify({ type: "balance", currency: "CNY", amount: "12.34" })), 300);
    }
  });
  // 2.5s 后模拟一次任务完成。
  setTimeout(() => {
    ws.send(JSON.stringify({ type: "task-complete", title: "测试任务", bubbleMs: 5000 }));
    console.log("[mock] sent task-complete");
  }, 2500);
  ws.on("close", () => console.log("[mock] PET DISCONNECTED"));
});
