import express from "express";
import http from "http";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import * as Game from "./game-service.js";
import { Firestore, FieldValue } from "@google-cloud/firestore";

dotenv.config(); // This loads the .env file

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // In production, restrict this to your Angular app's domain!
    methods: ["GET", "POST"],
  },
});

const gameTimeouts = new Map();

// Helper to start game and clear timeout
async function startGameLogic(gameCode) {
  // Clear any pending timeout for this game
  if (gameTimeouts.has(gameCode)) {
    clearTimeout(gameTimeouts.get(gameCode));
    gameTimeouts.delete(gameCode);
  }

  try {
    // Re-fetch game data to ensure we have the latest player list and state
    const gameData = await Game.getGameData(gameCode);
    if (!gameData) {
      console.log(`Game ${gameCode} not found. Aborting auto-start.`);
      return;
    }
    if (gameData.state !== "waiting") {
      console.log(
        `Game ${gameCode} is not in a 'waiting' state. Aborting auto-start.`
      );
      return;
    }

    const gameSeed = Math.floor(Math.random() * 3650);
    await Game.startGame(gameCode, gameSeed);

    console.log(`Game ${gameCode} starting! with seed ${gameSeed}`);
    io.to(gameCode).emit("message", { type: "gameStarted", gameSeed });
  } catch (error) {
    console.error(`Error auto-starting game ${gameCode}:`, error.message);
    io.to(gameCode).emit("message", {
      type: "error",
      message: `Failed to start game: ${error.message}`,
    });
  }
}

// Helper function to update game activity (TTL)
async function updateGameActivity(gameCode) {
  try {
    const db = new Firestore();
    const gameRef = db.collection("games").doc(gameCode);
    const now = new Date();
    const ttlTime = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes from now

    await gameRef.update({
      ttl: ttlTime,
      lastActivity: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error(`Error updating game activity for ${gameCode}:`, error);
  }
}

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // CREATE: A player creates a new game
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

      // Send game info back to the creator
      callback({
        success: true,
        gameCode,
        playerId, // Use the ID returned from the service
        players, // Use the player list returned from the service
        // New games never have ended, but include for consistency
        gameEnded: false,
        gameEndData: undefined,
      });
    } catch (error) {
      console.error("Error creating game:", error);
      callback({ success: false, message: error.message });
    }
  });

  // JOIN: A player joins an existing game or lobby
  socket.on("join", async ({ gameCode, playerId, playerName }, callback) => {
    try {
      // --- START: DUPLICATE CONNECTION HANDLING ---
      const gameDataForCheck = await Game.getGameData(gameCode);
      if (gameDataForCheck && playerId) {
        const existingPlayer = gameDataForCheck.players.find(
          (p) => p.id === playerId
        );

        // Check if the player exists, has a connectionId, and it's NOT the current socket's ID
        if (
          existingPlayer &&
          existingPlayer.connectionId &&
          existingPlayer.connectionId !== socket.id
        ) {
          console.log(
            `Duplicate connection for player ${existingPlayer.displayName} (${playerId}). Old socket: ${existingPlayer.connectionId}, New socket: ${socket.id}.`
          );

          // Find the old socket instance
          const oldSocket = io.sockets.sockets.get(existingPlayer.connectionId);

          if (oldSocket) {
            // 1. Notify the old client why it's being disconnected
            oldSocket.emit("forceDisconnect", {
              message:
                "You have connected from a new tab or browser. This session has been closed.",
            });
            // 2. Disconnect the old socket from the server
            oldSocket.disconnect(true);
            console.log(
              `Forcefully disconnected old socket: ${existingPlayer.connectionId}`
            );
          }
        }
      }
      // --- END: DUPLICATE CONNECTION HANDLING ---

      let finalPlayerId = playerId || uuidv4();
      const gameData = await Game.getGameData(gameCode);
      if (!gameData) {
        return callback({ success: false, message: "Game not found" });
      }

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
      // Broadcast the new player list to everyone *else* in the room.
      // The rejoining client gets its state from the callback.
      socket.broadcast.to(gameCode).emit("message", {
        type: "playerList",
        players: updatedGame.players,
      });

      // Check if game should start now that a player has joined/reconnected
      const connectedPlayers = updatedGame.players.filter(
        (p) => !p.disconnected
      );
      const allReady =
        connectedPlayers.length >= 2 && connectedPlayers.every((p) => p.ready);

      if (allReady) {
        console.log(
          `A player joined/reconnected and all players are now ready in ${gameCode}. Starting game.`
        );
        await startGameLogic(gameCode);
      }

      // Calculate current game time if the game is in progress
      let currentGameTime = 0;
      if (updatedGame.state === "playing" && updatedGame.gameStartTime) {
        currentGameTime = Game.calculateCurrentGameTime(
          updatedGame.gameStartTime
        );
      }

      // Reconstruct full game end data if available
      let gameEndData = undefined;
      if (updatedGame.lastGameEnd) {
        gameEndData = {
          type: "gameEnded",
          winner: updatedGame.lastGameEnd.winner,
          winnerDisplayName: updatedGame.lastGameEnd.winnerDisplayName,
          winnerEmoji: updatedGame.lastGameEnd.winnerEmoji,
          winnerColor: updatedGame.lastGameEnd.winnerColor,
          condensedGrid: JSON.parse(updatedGame.lastGameEnd.condensedGrid), // Parse back from string
          time: updatedGame.lastGameEnd.time,
          players: updatedGame.players, // Simplified: Always send the full current player list
          lastGameEndTimestamp: updatedGame.lastGameEndTimestamp?.toDate(), // Add timestamp here
        };
      }

      // Send join confirmation and player details to the joining player
      callback({
        success: true,
        playerId: finalPlayerId,
        gameCode,
        displayName: player.displayName,
        playerColor: player.playerColor,
        playerEmoji: player.playerEmoji,
        gameSeed: updatedGame.gameSeed,
        players: updatedGame.players,
        // Include last game end data if available (for players who missed the gameEnded message)
        gameEnded: !!updatedGame.lastGameEnd,
        gameEndData: gameEndData,
        lastGameEndTimestamp: updatedGame.lastGameEndTimestamp?.toDate(),
        // Include current game time and state for timer synchronization
        gameState: updatedGame.state,
        currentGameTime: currentGameTime,
        isGameActive: updatedGame.state === "playing",
      });
    } catch (error) {
      console.error(`Error on join for game ${gameCode}:`, error);
      callback({ success: false, message: error.message });
    }
  });

  // GET PLAYERS: A player requests the current player list (e.g., on reconnect)
  socket.on("getPlayers", async ({ gameCode }) => {
    const gameData = await Game.getGameData(gameCode);
    if (gameData) {
      // Update activity when players request player list
      await updateGameActivity(gameCode);

      // Calculate current game time if the game is in progress
      let currentGameTime = 0;
      if (gameData.state === "playing" && gameData.gameStartTime) {
        currentGameTime = Game.calculateCurrentGameTime(gameData.gameStartTime);
      }

      socket.emit("message", {
        type: "playerList",
        players: gameData.players,
        // Include game time information for timer sync
        gameState: gameData.state,
        currentGameTime: currentGameTime,
        isGameActive: gameData.state === "playing",
      });
    }
  });

  // PLAYER UPDATES: displayName, color, emoji
  socket.on(
    "updatePlayer",
    async ({ gameCode, playerId, updates }, callback) => {
      try {
        const updatedGame = await Game.updatePlayer(
          gameCode,
          playerId,
          updates
        );
        io.to(gameCode).emit("message", {
          type: "playerList",
          players: updatedGame.players,
        });
        callback({ success: true });
      } catch (error) {
        console.error(`Error updating player ${playerId}:`, error);
        callback({ success: false, message: error.message });
      }
    }
  );

  // WIN
  socket.on("win", async ({ gameCode, playerId, condensedGrid }, callback) => {
    try {
      // `endGame` no longer returns `activePlayers`
      const { updatedGame, winner, winTime } = await Game.endGame(
        gameCode,
        playerId,
        condensedGrid
      );

      // Re-fetch to get the server-set timestamp
      const latestGameData = await Game.getGameData(gameCode);

      const gameEndedMessage = {
        type: "gameEnded",
        winner: winner.id,
        winnerDisplayName: winner.displayName,
        winnerEmoji: winner.playerEmoji,
        winnerColor: winner.playerColor,
        condensedGrid,
        time: winTime, // Use server-calculated time
        players: updatedGame.players, // Simplified: Send the full, updated player list
        lastGameEndTimestamp: latestGameData.lastGameEndTimestamp.toDate(),
      };

      console.log(
        `Game ${gameCode} won by ${winner.displayName} in ${winTime}`
      );
      io.to(gameCode).emit("message", gameEndedMessage);

      // Set a 30-second timeout to start the next game
      const timeoutId = setTimeout(() => {
        console.log(
          `30-second timer expired for ${gameCode}. Starting next game.`
        );
        startGameLogic(gameCode);
      }, 30000);
      gameTimeouts.set(gameCode, timeoutId);

      // Acknowledge successful processing (if callback provided)
      if (callback) {
        callback({ success: true });
      }
    } catch (error) {
      if (error.message.includes("already ended")) {
        console.log(
          `Late win submission for game ${gameCode} by player ${playerId}. Ignoring.`
        );
        // Still acknowledge since this is expected behavior (if callback provided)
        if (callback) {
          callback({ success: true });
        }
      } else {
        console.error(`Error processing win for game ${gameCode}:`, error);
        // Acknowledge with error details (if callback provided)
        if (callback) {
          callback({ success: false, message: error.message });
        }
      }
    }
  });

  // PLAYER READY (new event)
  socket.on("playerReady", async ({ gameCode, playerId }, callback) => {
    try {
      const { updatedGameData, allReady } = await Game.setPlayerReady(
        gameCode,
        playerId
      );

      // Broadcast the updated player list so everyone's UI updates
      io.to(gameCode).emit("message", {
        type: "playerList",
        players: updatedGameData.players,
      });

      if (allReady) {
        console.log(`All players ready in ${gameCode}. Starting next game.`);
        await startGameLogic(gameCode);
      }
      callback({ success: true });
    } catch (error) {
      console.error(`Error on playerReady for game ${gameCode}:`, error);
      callback({ success: false, message: error.message });
    }
  });

  // POST GAME CELL CLICK
  socket.on("postGameCellClick", async ({ gameCode, row, col }) => {
    try {
      // Find the player who sent the click to get their color
      const gameData = await Game.getGameData(gameCode);
      if (!gameData) return; // Game not found, do nothing.

      const clickingPlayer = gameData.players.find(
        (p) => p.connectionId === socket.id
      );
      if (!clickingPlayer) return; // Player not found, do nothing.

      // Broadcast the click to other players in the room
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
          io.to(game.gameCode).emit("message", {
            type: "playerList",
            players: updatedPlayers,
          });
          console.log(
            `Marked player with connection ${socket.id} as disconnected in game ${game.gameCode}`
          );
        } else if (updatedPlayers) {
          // This case handles when an empty array is returned, meaning the game was deleted.
          console.log(
            `Game ${game.gameCode} deleted after final player disconnected.`
          );
        }
      }
    } catch (error) {
      console.error(`Error handling disconnect for ${socket.id}:`, error);
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
