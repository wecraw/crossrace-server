// game-service.js
import { Firestore, FieldValue } from "@google-cloud/firestore";

const db = new Firestore();
const GAMES_COLLECTION = "games";

// --- Helper Functions ---
const animalNicknames = [
  "Lion",
  "Tiger",
  "Bear",
  "Wolf",
  "Fox",
  "Elephant",
  "Giraffe",
  "Zebra",
  "Monkey",
  "Penguin",
  "Kangaroo",
  "Koala",
  "Panda",
  "Hippo",
  "Rhino",
  "Crocodile",
  "Dolphin",
  "Octopus",
  "Eagle",
  "Owl",
  "Otter",
  "Lizard",
  "Snake",
  "T-Rex",
  "Tuna",
  "Chicken",
  "Cow",
];
const defaultEmojis = [
  "🦁",
  "🐯",
  "🐻",
  "🐺",
  "🦊",
  "🐘",
  "🦒",
  "🦓",
  "🐵",
  "🐧",
  "🦘",
  "🐨",
  "🐼",
  "🦛",
  "🦏",
  "🐊",
  "🐬",
  "🐙",
  "🦅",
  "🦉",
  "🦦",
  "🦎",
  "🐍",
  "🦖",
  "🐟",
  "🐔",
  "🐮",
];
const colorPalette = [
  "#e6194b",
  "#3cb44b",
  "#ffe119",
  "#4363d8",
  "#f58231",
  "#911eb4",
  "#46f0f0",
  "#f032e6",
  "#bcf60c",
  "#fabebe",
  "#008080",
  "#e6beff",
  "#9a6324",
  "#fffac8",
  "#800000",
  "#aaffc3",
  "#808000",
  "#ffd8b1",
  "#000075",
  "#808080",
];

function generateGameCode() {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let result = "";
  for (let i = 0; i < 4; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

function getUniqueNameAndEmoji(existingPlayers = []) {
  let displayName, playerEmoji;
  const usedNames = new Set(existingPlayers.map((p) => p.displayName));
  const usedEmojis = new Set(existingPlayers.map((p) => p.playerEmoji));

  do {
    const index = Math.floor(Math.random() * animalNicknames.length);
    displayName = animalNicknames[index];
    playerEmoji = defaultEmojis[index];
  } while (usedNames.has(displayName) || usedEmojis.has(playerEmoji));

  return { displayName, playerEmoji };
}

function getRandomColor() {
  return colorPalette[Math.floor(Math.random() * colorPalette.length)];
}

// --- Firestore Functions ---

export async function createGame(playerId, connectionId) {
  const gameCode = generateGameCode();
  const gameRef = db.collection(GAMES_COLLECTION).doc(gameCode);

  const { displayName, playerEmoji } = getUniqueNameAndEmoji();
  const playerColor = getRandomColor();

  const hostPlayer = {
    id: playerId,
    connectionId: connectionId,
    displayName,
    playerColor,
    playerEmoji,
    isHost: true,
    ready: false,
    inGame: false,
    winCount: 0,
    disconnected: false,
  };

  await gameRef.set({
    gameCode,
    players: [hostPlayer],
    state: "waiting",
    createdAt: FieldValue.serverTimestamp(),
  });

  return { gameCode, player: hostPlayer };
}

export async function getGameData(gameCode) {
  const doc = await db.collection(GAMES_COLLECTION).doc(gameCode).get();
  return doc.exists ? doc.data() : null;
}

export async function findGameByPlayerId(playerId) {
  const snapshot = await db
    .collection(GAMES_COLLECTION)
    .where("players", "array-contains", { id: playerId })
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  return snapshot.docs[0].data();
}

export async function findGameByConnectionId(connectionId) {
  const snapshot = await db
    .collection(GAMES_COLLECTION)
    .where("players", "array-contains-any", [{ connectionId: connectionId }]) // This is a simplification; requires more robust querying
    .get();

  // Firestore `array-contains-any` is tricky with objects. We'll have to filter client-side.
  // A better data model would be a subcollection of players. For now, this scan is okay for small scale.
  let gameDoc = null;
  const querySnapshot = await db.collection(GAMES_COLLECTION).get();
  querySnapshot.forEach((doc) => {
    const game = doc.data();
    if (
      game.players &&
      game.players.some((p) => p.connectionId === connectionId)
    ) {
      gameDoc = game;
    }
  });
  return gameDoc;
}

// game-service.js
export async function addPlayerToGame(gameCode, playerId, connectionId) {
  const gameRef = db.collection(GAMES_COLLECTION).doc(gameCode);
  const gameDoc = await gameRef.get();
  if (!gameDoc.exists) throw new Error("Game not found");

  let players = gameDoc.data().players || [];
  const playerIndex = players.findIndex((p) => p.id === playerId);

  // A host is needed if no currently connected player is the host.
  const needsHost = !players.some((p) => p.isHost && !p.disconnected);

  if (playerIndex > -1) {
    // --- REJOIN LOGIC ---
    console.log(
      `Player ${players[playerIndex].displayName} (${playerId}) is rejoining.`
    );
    players[playerIndex].connectionId = connectionId;
    players[playerIndex].disconnected = false; // Player is now reconnected
    players[playerIndex].inGame = false; // Ensure they are not marked as in-game
    players[playerIndex].ready = false; // A rejoining player is never ready by default

    // If the game was hostless, this rejoining player becomes the new host.
    if (needsHost) {
      console.log(
        `Game was hostless. Assigning host to ${players[playerIndex].displayName}.`
      );
      // Ensure no other player is marked as host.
      players.forEach((p) => (p.isHost = false));
      players[playerIndex].isHost = true;
    }

    await gameRef.update({ players: players });
    return { player: players[playerIndex], isNew: false };
  } else {
    // --- NEW PLAYER LOGIC ---
    console.log(`New player with ID ${playerId} is joining.`);
    const { displayName, playerEmoji } = getUniqueNameAndEmoji(players);
    const playerColor = getRandomColor();

    const newPlayer = {
      id: playerId,
      connectionId: connectionId,
      displayName,
      playerColor,
      playerEmoji,
      isHost: needsHost, // Become host if the game needs one.
      ready: false,
      inGame: false,
      winCount: 0,
      disconnected: false,
    };

    if (needsHost) {
      console.log(
        `Game was hostless. Assigning host to new player ${displayName}.`
      );
    }

    await gameRef.update({
      players: FieldValue.arrayUnion(newPlayer),
    });
    return { player: newPlayer, isNew: true };
  }
}

export async function setPlayerDisconnected(gameCode, connectionId) {
  const gameRef = db.collection(GAMES_COLLECTION).doc(gameCode);
  const gameDoc = await gameRef.get();
  if (!gameDoc.exists) {
    console.log(`Game ${gameCode} not found during disconnect handling.`);
    return null;
  }

  let players = gameDoc.data().players;
  const playerIndex = players.findIndex((p) => p.connectionId === connectionId);

  if (playerIndex === -1) {
    // Player not found, may have already been handled or reconnected with a new socket.
    return players;
  }

  const playerToDisconnect = players[playerIndex];
  console.log(`Disconnecting player: ${playerToDisconnect.displayName}`);

  // Mark player as disconnected
  players[playerIndex].disconnected = true;
  players[playerIndex].connectionId = null;

  // If the disconnecting player was the host, find a new one from connected players.
  if (players[playerIndex].isHost) {
    console.log(
      `Host ${playerToDisconnect.displayName} disconnected. Finding new host.`
    );
    players[playerIndex].isHost = false;

    // Find the first available CONNECTED player to promote to host.
    const newHostIndex = players.findIndex((p) => !p.disconnected);

    if (newHostIndex > -1) {
      players[newHostIndex].isHost = true;
      console.log(`New host is ${players[newHostIndex].displayName}.`);
    } else {
      console.log("No connected players left. Game is now hostless.");
    }
  }

  // Persist the changes. We no longer delete the game document.
  await gameRef.update({ players: players });

  // Return the updated list of all players (including disconnected ones).
  return players;
}

export async function removePlayer(gameCode, connectionId) {
  const gameRef = db.collection(GAMES_COLLECTION).doc(gameCode);
  const gameDoc = await gameRef.get();
  if (!gameDoc.exists) return null;

  let players = gameDoc.data().players;
  const playerToRemove = players.find((p) => p.connectionId === connectionId);

  if (!playerToRemove) return players; // Player already removed

  let updatedPlayers = players.filter((p) => p.connectionId !== connectionId);

  // If the host disconnected, assign a new host
  if (playerToRemove.isHost && updatedPlayers.length > 0) {
    updatedPlayers[0].isHost = true;
  }

  if (updatedPlayers.length === 0) {
    // Optional: Delete the game if everyone leaves
    await gameRef.delete();
    return [];
  } else {
    await gameRef.update({ players: updatedPlayers });
    return updatedPlayers;
  }
}

export async function updatePlayer(gameCode, playerId, updates) {
  const gameRef = db.collection(GAMES_COLLECTION).doc(gameCode);
  const gameDoc = await gameRef.get();
  if (!gameDoc.exists) throw new Error("Game not found");

  const players = gameDoc.data().players;
  const playerIndex = players.findIndex((p) => p.id === playerId);
  if (playerIndex === -1) throw new Error("Player not found");

  // Merge updates into the player object
  players[playerIndex] = { ...players[playerIndex], ...updates };

  await gameRef.update({ players: players });
  return await getGameData(gameCode);
}

export async function startGame(gameCode) {
  const gameRef = db.collection(GAMES_COLLECTION).doc(gameCode);
  const gameDoc = await gameRef.get();
  if (!gameDoc.exists) throw new Error("Game not found");

  const gameData = gameDoc.data();
  const connectedPlayers = gameData.players.filter((p) => !p.disconnected);

  // Validation: Check if there are players and if all connected players are ready
  if (connectedPlayers.length === 0) {
    throw new Error("Cannot start a game with no connected players.");
  }
  const allReady = connectedPlayers.every((p) => p.ready);
  if (!allReady) {
    throw new Error("Not all players are ready.");
  }

  // Store the IDs of players who are participating in this game
  const currentGameParticipants = connectedPlayers.map((p) => p.id);

  // Update all players in the game, marking connected ones as inGame
  const players = gameData.players.map((p) => {
    // Only modify players who are actually connected and playing this round
    if (!p.disconnected) {
      return {
        ...p,
        inGame: true,
        ready: false, // Reset ready status for the next round
      };
    }
    return p; // Return disconnected players unchanged
  });

  await gameRef.update({
    state: "playing",
    players,
    currentGameParticipants: currentGameParticipants,
    lastGameEnd: FieldValue.delete(), // Clear any previous game end data
  });
  return await getGameData(gameCode);
}

export async function endGame(gameCode, winnerId, condensedGrid, time) {
  const gameRef = db.collection(GAMES_COLLECTION).doc(gameCode);
  const gameDoc = await gameRef.get();
  if (!gameDoc.exists) throw new Error("Game not found");

  const winner = gameDoc.data().players.find((p) => p.id === winnerId);
  if (!winner) throw new Error("Winner not found");

  // This update must be atomic. We use a transaction.
  const updatedGameData = await db.runTransaction(async (transaction) => {
    const freshGameDoc = await transaction.get(gameRef);
    if (freshGameDoc.data().state !== "playing") {
      // Another player already won
      throw new Error("Game has already ended.");
    }

    const gameData = freshGameDoc.data();
    const participantIds = gameData.currentGameParticipants || [];

    // Get the participants who were in the game (regardless of current connection status)
    const activePlayers = gameData.players.filter((p) =>
      participantIds.includes(p.id)
    );

    const players = gameData.players.map((p) => ({
      ...p,
      inGame: false,
      ready: false,
      winCount: p.id === winnerId ? (p.winCount || 0) + 1 : p.winCount || 0,
    }));

    // Store the game end data for players who might reconnect after missing the message
    const gameEndData = {
      winner: winnerId,
      winnerDisplayName: winner.displayName,
      winnerEmoji: winner.playerEmoji,
      winnerColor: winner.playerColor,
      condensedGrid,
      time,
      endedAt: FieldValue.serverTimestamp(),
      players: activePlayers.map((p) => ({
        ...p,
        inGame: false,
        ready: false,
        winCount: p.id === winnerId ? (p.winCount || 0) + 1 : p.winCount || 0,
      })),
    };

    // Clear the current game participants list and store the game end data
    transaction.update(gameRef, {
      state: "waiting",
      players,
      currentGameParticipants: FieldValue.delete(),
      lastGameEnd: gameEndData,
    });

    return {
      ...gameData,
      state: "waiting",
      players,
      activePlayers: activePlayers.map((p) => ({
        ...p,
        inGame: false,
        ready: false,
        winCount: p.id === winnerId ? (p.winCount || 0) + 1 : p.winCount || 0,
      })),
    };
  });

  return {
    updatedGame: updatedGameData,
    winner,
    activePlayers: updatedGameData.activePlayers,
  };
}
