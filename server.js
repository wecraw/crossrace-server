// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import * as Game from "./game-service.js";

dotenv.config(); // This loads the .env file

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // In production, restrict this to your Angular app's domain!
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // CREATE: A player creates a new game
  socket.on("create", async (callback) => {
    try {
      const playerId = uuidv4();
      const { gameCode, player } = await Game.createGame(playerId, socket.id);
      socket.join(gameCode); // The creator joins the socket.io room for the game
      console.log(
        `Player ${player.displayName} (${playerId}) created game ${gameCode}`
      );
      // Send game info back to the creator
      callback({
        success: true,
        gameCode,
        playerId,
        displayName: player.displayName,
        playerColor: player.playerColor,
        playerEmoji: player.playerEmoji,
        // New games never have ended, but include for consistency
        gameEnded: false,
        gameEndData: undefined,
      });
      // Send the initial player list to the creator
      io.to(gameCode).emit("playerList", { players: [player] });
    } catch (error) {
      console.error("Error creating game:", error);
      callback({ success: false, message: error.message });
    }
  });

  // JOIN: A player joins an existing game
  socket.on("join", async ({ gameCode, playerId }, callback) => {
    try {
      let finalPlayerId = playerId || uuidv4();
      const gameData = await Game.getGameData(gameCode);
      if (!gameData) {
        return callback({ success: false, message: "Game not found." });
      }

      const { player } = await Game.addPlayerToGame(
        gameCode,
        finalPlayerId,
        socket.id
      );
      socket.join(gameCode);
      console.log(
        `Player ${player.displayName} (${finalPlayerId}) joined game ${gameCode}`
      );

      const updatedGame = await Game.getGameData(gameCode);
      // Broadcast the new player list to everyone in the room
      io.to(gameCode).emit("message", {
        type: "playerList",
        players: updatedGame.players,
      });

      // Send join confirmation and player details to the joining player
      callback({
        success: true,
        type: "selfJoined", // This tells the joining client their own details
        playerId: finalPlayerId,
        gameCode,
        displayName: player.displayName,
        playerColor: player.playerColor,
        playerEmoji: player.playerEmoji,
        // Include last game end data if available (for players who missed the gameEnded message)
        gameEnded: !!updatedGame.lastGameEnd,
        gameEndData: updatedGame.lastGameEnd || undefined,
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
      socket.emit("message", { type: "playerList", players: gameData.players });
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

  // PLAYER READY
  socket.on("playerReady", async ({ gameCode, playerId }) => {
    try {
      const updatedGame = await Game.updatePlayer(gameCode, playerId, {
        ready: true,
      });
      io.to(gameCode).emit("message", {
        type: "playerList",
        players: updatedGame.players,
      });
    } catch (error) {
      console.error(`Error on playerReady for ${playerId}:`, error);
    }
  });

  // START GAME
  socket.on("startGame", async ({ gameCode }) => {
    try {
      // The game-service now handles validation (all connected players are ready)
      await Game.startGame(gameCode);
      const gameSeed = Math.floor(Math.random() * 3650);

      console.log(`Game ${gameCode} starting! with seed ${gameSeed}`);
      io.to(gameCode).emit("message", { type: "gameStarted", gameSeed });
    } catch (error) {
      console.error(`Error starting game ${gameCode}:`, error.message);
      // Let the client know why starting the game failed.
      socket.emit("message", {
        type: "error",
        message: `Failed to start game: ${error.message}`,
      });
    }
  });

  // WIN
  socket.on("win", async ({ gameCode, playerId, condensedGrid, time }) => {
    try {
      const { updatedGame, winner, activePlayers } = await Game.endGame(
        gameCode,
        playerId,
        condensedGrid,
        time
      );

      const gameEndedMessage = {
        type: "gameEnded",
        winner: winner.id,
        winnerDisplayName: winner.displayName,
        winnerEmoji: winner.playerEmoji,
        winnerColor: winner.playerColor,
        condensedGrid,
        time,
        players: activePlayers, // Only show players who were actively in the game
      };

      console.log(`Game ${gameCode} won by ${winner.displayName}`);
      io.to(gameCode).emit("message", gameEndedMessage);
    } catch (error) {
      if (error.message.includes("already ended")) {
        console.log(
          `Late win submission for game ${gameCode} by player ${playerId}. Ignoring.`
        );
      } else {
        console.error(`Error processing win for game ${gameCode}:`, error);
      }
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
