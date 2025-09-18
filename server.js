import express from "express";
import http from "http";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import * as Game from "./game-service.js";
import { Firestore, FieldValue } from "@google-cloud/firestore";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // TODO: restrict to your app domain in production
    methods: ["GET", "POST"],
  },
});

const gameTimeouts = new Map();

// ---- Helpers ---------------------------------------------------------
async function startGameLogic(gameCode) {
  if (gameTimeouts.has(gameCode)) {
    clearTimeout(gameTimeouts.get(gameCode));
    gameTimeouts.delete(gameCode);
  }
  try {
    const gameData = await Game.getGameData(gameCode);
    if (!gameData) return;
    if (gameData.state !== "waiting") return;

    const gameSeed = Math.floor(Math.random() * 3650);
    await Game.startGame(gameCode, gameSeed);

    const snapshot = await Game.assembleGameStateSnapshot(gameCode);
    io.to(gameCode).emit("message", { type: "gameStateSnapshot", snapshot });
  } catch (error) {
    console.error(`Error auto-starting game ${gameCode}:`, error.message);
    io.to(gameCode).emit("message", {
      type: "error",
      message: `Failed to start game: ${error.message}`,
    });
  }
}

async function updateGameActivity(gameCode) {
  try {
    const db = new Firestore();
    const gameRef = db.collection("games").doc(gameCode);
    const now = new Date();
    const ttlTime = new Date(now.getTime() + 10 * 60 * 1000);
    await gameRef.update({
      ttl: ttlTime,
      lastActivity: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error(`Error updating game activity for ${gameCode}:`, error);
  }
}
// ---------------------------------------------------------------------

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // CREATE
  socket.on("create", async ({ playerName }, callback) => {
    try {
      if (!playerName) {
        return callback({
          success: false,
          message: "Player name is required.",
        });
      }
      const newPlayerId = uuidv4();
      const { gameCode, playerId, players } = await Game.createGame(
        newPlayerId,
        socket.id,
        playerName
      );

      socket.join(gameCode);
      const newPlayer = players[0];
      console.log(
        `Player ${newPlayer.displayName} (${playerId}) created game ${gameCode}`
      );

      callback({ success: true, gameCode, playerId, players });

      const snapshot = await Game.assembleGameStateSnapshot(gameCode);
      if (snapshot) {
        io.to(gameCode).emit("message", {
          type: "gameStateSnapshot",
          snapshot,
        });
      }
    } catch (error) {
      console.error("Error creating game:", error);
      callback({ success: false, message: error.message });
    }
  });

  // JOIN
  socket.on("join", async ({ gameCode, playerId, playerName }, callback) => {
    try {
      // Handle duplicate sockets for same player
      const gameDataForCheck = await Game.getGameData(gameCode);
      if (gameDataForCheck && playerId) {
        const existingPlayer = gameDataForCheck.players.find(
          (p) => p.id === playerId
        );
        if (
          existingPlayer &&
          existingPlayer.connectionId &&
          existingPlayer.connectionId !== socket.id
        ) {
          const oldSocket = io.sockets.sockets.get(existingPlayer.connectionId);
          if (oldSocket) {
            oldSocket.emit("forceDisconnect", {
              message:
                "You have connected from a new tab or browser. This session has been closed.",
            });
            oldSocket.disconnect(true);
          }
        }
      }

      const finalPlayerId = playerId || uuidv4();
      const gameData = await Game.getGameData(gameCode);
      if (!gameData)
        return callback({ success: false, message: "Game not found" });

      const { player } = await Game.addPlayerToGame(
        gameCode,
        finalPlayerId,
        socket.id,
        playerName
      );

      socket.join(gameCode);
      console.log(
        `Player ${player.displayName} (${finalPlayerId}) joined game ${gameCode}`
      );

      const updatedGame = await Game.getGameData(gameCode);

      // Broadcast snapshot to room
      const broadcastSnapshot = await Game.assembleGameStateSnapshot(
        gameCode,
        updatedGame
      );
      if (broadcastSnapshot) {
        socket.broadcast.to(gameCode).emit("message", {
          type: "gameStateSnapshot",
          snapshot: broadcastSnapshot,
        });
      }

      // Reply to joiner with snapshot
      const snapshot = await Game.assembleGameStateSnapshot(
        gameCode,
        updatedGame
      );
      callback({
        success: true,
        playerId: finalPlayerId,
        gameCode,
        displayName: player.displayName,
        playerColor: player.playerColor,
        playerEmoji: player.playerEmoji,
        players: updatedGame.players,
        gameStateSnapshot: snapshot,
      });
    } catch (error) {
      console.error(`Error on join for game ${gameCode}:`, error);
      callback({ success: false, message: error.message });
    }
  });

  // GET PLAYERS (snapshot convenience)
  socket.on("getPlayers", async ({ gameCode }) => {
    const gameData = await Game.getGameData(gameCode);
    if (!gameData) return;
    await updateGameActivity(gameCode);
    const snapshot = await Game.assembleGameStateSnapshot(gameCode, gameData);
    if (snapshot) {
      socket.emit("message", { type: "gameStateSnapshot", snapshot });
    }
  });

  // UPDATE PLAYER
  socket.on(
    "updatePlayer",
    async ({ gameCode, playerId, updates }, callback) => {
      try {
        const updatedGame = await Game.updatePlayer(
          gameCode,
          playerId,
          updates
        );
        const snapshot = await Game.assembleGameStateSnapshot(
          gameCode,
          updatedGame
        );
        if (snapshot) {
          io.to(gameCode).emit("message", {
            type: "gameStateSnapshot",
            snapshot,
          });
        }
        callback({ success: true });
      } catch (error) {
        console.error(`Error updating player ${playerId}:`, error);
        callback({ success: false, message: error.message });
      }
    }
  );

  // READY UP (restored)
  socket.on("playerReady", async ({ gameCode, playerId }, callback) => {
    try {
      const { updatedGameData, allReady } = await Game.setPlayerReady(
        gameCode,
        playerId
      );

      const snapshot = await Game.assembleGameStateSnapshot(
        gameCode,
        updatedGameData
      );
      if (snapshot) {
        io.to(gameCode).emit("message", {
          type: "gameStateSnapshot",
          snapshot,
        });
      }

      if (allReady) {
        await startGameLogic(gameCode);
      }

      callback({ success: true });
    } catch (error) {
      console.error(`Error on playerReady for game ${gameCode}:`, error);
      callback({ success: false, message: error.message });
    }
  });

  // WIN
  socket.on("win", async ({ gameCode, playerId, condensedGrid }, callback) => {
    try {
      await Game.endGame(gameCode, playerId, condensedGrid);

      const snapshot = await Game.assembleGameStateSnapshot(gameCode);
      io.to(gameCode).emit("message", { type: "gameStateSnapshot", snapshot });

      const timeoutId = setTimeout(() => {
        startGameLogic(gameCode);
      }, 30000);
      gameTimeouts.set(gameCode, timeoutId);

      if (callback) callback({ success: true });
    } catch (error) {
      if (error.message.includes("already ended")) {
        if (callback) callback({ success: true });
      } else {
        console.error(`Error processing win for game ${gameCode}:`, error);
        if (callback) callback({ success: false, message: error.message });
      }
    }
  });

  // POST GAME CELL CLICK
  socket.on("postGameCellClick", async ({ gameCode, row, col }) => {
    try {
      const gameData = await Game.getGameData(gameCode);
      if (!gameData) return;
      const clickingPlayer = gameData.players.find(
        (p) => p.connectionId === socket.id
      );
      if (!clickingPlayer) return;

      socket.broadcast.to(gameCode).emit("message", {
        type: "postGameCellClicked",
        row,
        col,
        color: clickingPlayer.playerColor,
      });
    } catch (error) {
      console.error(
        `Error handling postGameCellClick for game ${gameCode}:`,
        error
      );
    }
  });

  // DISCONNECT
  socket.on("disconnect", async () => {
    console.log(`Client disconnected: ${socket.id}`);
    try {
      const game = await Game.findGameByConnectionId(socket.id);
      if (game) {
        const updatedPlayers = await Game.setPlayerDisconnected(
          game.gameCode,
          socket.id
        );
        if (updatedPlayers && updatedPlayers.length > 0) {
          const snapshot = await Game.assembleGameStateSnapshot(game.gameCode);
          if (snapshot) {
            io.to(game.gameCode).emit("message", {
              type: "gameStateSnapshot",
              snapshot,
            });
          }
        } else if (updatedPlayers) {
          console.log(
            `Game ${game.gameCode} deleted after final player disconnected.`
          );
        }
      }
      await Game.deleteConnectionIndex(socket.id);
    } catch (error) {
      console.error(`Error handling disconnect for ${socket.id}:`, error);
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
