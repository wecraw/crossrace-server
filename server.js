const WebSocket = require("ws");

const wss = new WebSocket.Server({ port: 8080 });

const games = new Map();

function generateGameCode() {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let result = "";
  for (let i = 0; i < 4; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

wss.on("connection", (ws) => {
  ws.on("message", (message) => {
    const data = JSON.parse(message);

    switch (data.type) {
      case "create":
        let gameCode;
        do {
          gameCode = generateGameCode();
        } while (games.has(gameCode));

        games.set(gameCode, { players: [ws], state: "waiting" });
        ws.send(JSON.stringify({ type: "gameCreated", gameCode }));
        break;

      case "join":
        const game = games.get(data.gameCode);
        if (game && game.state === "waiting") {
          game.players.push(ws);
          game.state = "playing";
          game.players.forEach((player) =>
            player.send(JSON.stringify({ type: "gameStarted" }))
          );
        } else {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Game not found or already in progress",
            })
          );
        }
        break;

      case "win":
        const winningGame = Array.from(games.entries()).find(([_, g]) =>
          g.players.includes(ws)
        );
        if (winningGame) {
          const [winningGameCode, winningGameData] = winningGame;
          winningGameData.players.forEach((player) =>
            player.send(
              JSON.stringify({ type: "gameEnded", winner: player === ws })
            )
          );
          games.delete(winningGameCode);
        }
        break;
    }
  });
});
