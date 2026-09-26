import { createWatchTogetherSignalingServer } from "../services/watch-together-signaling/server.js";

const signalingService = createWatchTogetherSignalingServer();

const address = await signalingService.listen();

console.log(`TorPlay Watch Together signaling listening on ${
  typeof address === "string" ? address : `${address.address}:${address.port}`
}`);

export default signalingService.httpServer;
