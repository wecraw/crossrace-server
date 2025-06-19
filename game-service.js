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

export async function addPlayerToGame(gameCode, playerId, connectionId) {
  const gameRef = db.collection(GAMES_COLLECTION).doc(gameCode);
  const gameDoc = await gameRef.get();
  if (!gameDoc.exists) throw new Error("Game not found");

  const players = gameDoc.data().players || [];
  const playerIndex = players.findIndex((p) => p.id === playerId);

  if (playerIndex > -1) {
    // --- THIS IS THE REJOIN LOGIC ---
    // The player already exists. Update their connectionId and set inGame to false.
    console.log(
      `Player ${players[playerIndex].displayName} (${playerId}) is rejoining.`
    );
    players[playerIndex].connectionId = connectionId;
    players[playerIndex].inGame = false; // Ensure they are not marked as in-game

    await gameRef.update({ players: players });
    return { player: players[playerIndex], isNew: false };
  } else {
    // --- THIS IS THE NEW PLAYER LOGIC ---
    // Player does not exist, create a new one.
    console.log(`New player with ID ${playerId} is joining.`);
    const { displayName, playerEmoji } = getUniqueNameAndEmoji(players);
    const playerColor = getRandomColor();

    const newPlayer = {
      id: playerId,
      connectionId: connectionId,
      displayName,
      playerColor,
      playerEmoji,
      isHost: false,
      ready: false,
      inGame: false,
      winCount: 0,
    };

    await gameRef.update({
      players: FieldValue.arrayUnion(newPlayer),
    });
    return { player: newPlayer, isNew: true };
  }
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

  const players = gameDoc.data().players.map((p) => ({
    ...p,
    inGame: true,
    ready: false, // Reset ready status for next round
  }));

  await gameRef.update({ state: "playing", players });
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

    const players = freshGameDoc.data().players.map((p) => ({
      ...p,
      inGame: false,
      ready: false,
      winCount: p.id === winnerId ? (p.winCount || 0) + 1 : p.winCount || 0,
    }));

    transaction.update(gameRef, { state: "waiting", players });
    return { ...freshGameDoc.data(), state: "waiting", players };
  });

  return { updatedGame: updatedGameData, winner };
}
