import { Firestore, FieldValue } from "@google-cloud/firestore";
import {
  GAME_CONFIG,
  DEFAULT_EMOJIS,
  COLOR_PALETTE,
  FIRESTORE_CONFIG,
} from "./game-constants.js";

const db = new Firestore();
const CONNECTION_INDEX_COLLECTION =
  FIRESTORE_CONFIG?.CONNECTION_INDEX_COLLECTION || "connectionIndex";

function generateGameCode() {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let result = "";
  for (let i = 0; i < 4; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

function getUniqueEmoji(existingPlayers = []) {
  let playerEmoji;
  const usedEmojis = new Set(
    existingPlayers.map((p) => p.playerEmoji).filter(Boolean)
  );
  // Handle case where all emojis are used to prevent infinite loops
  if (usedEmojis.size >= DEFAULT_EMOJIS.length) {
    return DEFAULT_EMOJIS[Math.floor(Math.random() * DEFAULT_EMOJIS.length)];
  }
  do {
    const index = Math.floor(Math.random() * DEFAULT_EMOJIS.length);
    playerEmoji = DEFAULT_EMOJIS[index];
  } while (usedEmojis.has(playerEmoji));
  return playerEmoji;
}

function getRandomColor() {
  return COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
}

function getTTLTimestamp() {
  // Set TTL to 10 minutes from now
  const now = new Date();
  const ttlTime = new Date(now.getTime() + GAME_CONFIG.TTL_MINUTES * 60 * 1000);
  return ttlTime;
}

// ---------- Connection Index helpers (NEW) ----------
export async function upsertConnectionIndex(connectionId, gameCode) {
  if (!connectionId || !gameCode) return;
  const ref = db.collection(CONNECTION_INDEX_COLLECTION).doc(connectionId);
  await ref.set(
    {
      connectionId,
      gameCode,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

export async function deleteConnectionIndex(connectionId) {
  if (!connectionId) return;
  const ref = db.collection(CONNECTION_INDEX_COLLECTION).doc(connectionId);
  await ref.delete().catch(() => {});
}
// ---------------------------------------------------

/** Returns full game data or null */
export async function getGameData(gameCode) {
  const doc = await db
    .collection(FIRESTORE_CONFIG.GAMES_COLLECTION)
    .doc(gameCode)
    .get();
  return doc.exists ? doc.data() : null;
}

export async function createGame(playerId, connectionId, displayName) {
  const gamesRef = db.collection(FIRESTORE_CONFIG.GAMES_COLLECTION);
  const maxRetries = 10; // Prevent an infinite loop in case of high traffic

  for (let i = 0; i < maxRetries; i++) {
    const gameCode = generateGameCode();
    const gameRef = gamesRef.doc(gameCode);
    try {
      const result = await db.runTransaction(async (transaction) => {
        const gameDoc = await transaction.get(gameRef);

        // This host player object will be used for either creating or reusing a game
        const playerEmoji = getUniqueEmoji();
        const playerColor = getRandomColor();
        const newPlayer = {
          id: playerId,
          connectionId: connectionId,
          displayName,
          playerColor,
          playerEmoji,
          inGame: false,
          winCount: 0,
          disconnected: false,
          ready: false,
        };

        if (!gameDoc.exists) {
          // CASE 1: The room code is available. Create a new game document.
          console.log(`Code ${gameCode} is available. Creating new game.`);
          const newGameData = {
            gameCode,
            players: [newPlayer],
            state: "waiting",
            createdAt: FieldValue.serverTimestamp(),
            ttl: getTTLTimestamp(),
            lastActivity: FieldValue.serverTimestamp(),
          };
          transaction.create(gameRef, newGameData);
          return { gameCode, playerId: newPlayer.id, players: [newPlayer] };
        }

        // CASE 2: The room code exists. Check if it's expired and can be reused.
        const existingGame = gameDoc.data();
        const ttl = existingGame.ttl?.toDate(); // Safely access and convert timestamp
        if (ttl && ttl < new Date()) {
          // CASE 2a: The game is expired (TTL is in the past). Reuse it.
          console.log(`Code ${gameCode} exists but is expired. Reusing.`);
          const reusedGameData = {
            gameCode,
            players: [newPlayer], // Reset with the new player
            state: "waiting",
            createdAt: FieldValue.serverTimestamp(), // Update creation time
            ttl: getTTLTimestamp(), // Set a new TTL for the new session
            lastActivity: FieldValue.serverTimestamp(),
            // Ensure old game-specific fields are cleared on reuse
            lastGameEnd: FieldValue.delete(),
            lastGameEndTimestamp: FieldValue.delete(),
            currentGameParticipants: FieldValue.delete(),
            gameStartTime: FieldValue.delete(),
          };
          transaction.set(gameRef, reusedGameData); // Use set() to completely overwrite the old doc
          return { gameCode, playerId: newPlayer.id, players: [newPlayer] };
        }

        // CASE 2b: The game is active. We need to generate a new code and retry.
        console.log(`Code ${gameCode} is actively in use. Retrying...`);
        return null; // Returning null signals that this attempt failed and the loop should continue
      });

      if (result) {
        // Maintain connection index for the host's socket
        await upsertConnectionIndex(connectionId, result.gameCode);
        return result;
      }
      // If result is null, it means the code was active, and the loop will continue.
    } catch (error) {
      // This catches errors from the transaction itself (e.g., contention).
      // The loop will automatically retry.
      console.warn(
        `Transaction for ${gameCode} failed, retrying. Error: ${error.message}`
      );
    }
  }

  // If we exit the loop, we failed to find a free game code after all retries.
  throw new Error(
    "Failed to create a game after multiple attempts. The server may be busy."
  );
}

export async function findGameByPlayerId(playerId) {
  const snapshot = await db
    .collection(FIRESTORE_CONFIG.GAMES_COLLECTION)
    .where("players", "array-contains", { id: playerId })
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  return snapshot.docs[0].data();
}

/**
 * Efficient lookup using the connectionIndex (REWRITTEN).
 * Avoids scanning the entire games collection.
 */
export async function findGameByConnectionId(connectionId) {
  if (!connectionId) return null;
  const idxDoc = await db
    .collection(CONNECTION_INDEX_COLLECTION)
    .doc(connectionId)
    .get();
  if (!idxDoc.exists) return null;
  const gameCode = idxDoc.get("gameCode");
  if (!gameCode) return null;
  return await getGameData(gameCode);
}

// Helper function to update game activity
async function updateGameActivity(gameCode) {
  const gameRef = db
    .collection(FIRESTORE_CONFIG.GAMES_COLLECTION)
    .doc(gameCode);
  await gameRef.update({
    ttl: getTTLTimestamp(),
    lastActivity: FieldValue.serverTimestamp(),
  });
}

export async function addPlayerToGame(
  gameCode,
  playerId,
  connectionId,
  displayName
) {
  const gameRef = db
    .collection(FIRESTORE_CONFIG.GAMES_COLLECTION)
    .doc(gameCode);
  const gameDoc = await gameRef.get();
  if (!gameDoc.exists) throw new Error("Game not found");

  let players = gameDoc.data().players || [];
  const playerIndex = players.findIndex((p) => p.id === playerId);

  if (playerIndex > -1) {
    // --- REJOIN LOGIC ---
    const existingPlayer = players[playerIndex];
    console.log(
      `Player ${existingPlayer.displayName} (${playerId}) is rejoining.`
    );
    existingPlayer.connectionId = connectionId;
    existingPlayer.disconnected = false; // Player is now reconnected
    existingPlayer.inGame = false; // Ensure they are not marked as in-game
    existingPlayer.ready = false; // Reset ready status on rejoin
    // If a new name is provided on rejoin, update it.
    if (displayName && existingPlayer.displayName !== displayName) {
      console.log(
        `Updating name for rejoining player ${playerId} from "${existingPlayer.displayName}" to "${displayName}".`
      );
      existingPlayer.displayName = displayName;
    }
    await gameRef.update({
      players: players,
      // Update TTL when player joins
      ttl: getTTLTimestamp(),
      lastActivity: FieldValue.serverTimestamp(),
    });
    await upsertConnectionIndex(connectionId, gameCode);
    return { player: existingPlayer, isNew: false };
  } else {
    // --- NEW PLAYER LOGIC ---
    if (!displayName) {
      throw new Error("A display name is required for a new player.");
    }
    console.log(`New player "${displayName}" with ID ${playerId} is joining.`);
    const playerEmoji = getUniqueEmoji(players);
    const playerColor = getRandomColor();
    const newPlayer = {
      id: playerId,
      connectionId: connectionId,
      displayName,
      playerColor,
      playerEmoji,
      inGame: false,
      winCount: 0,
      disconnected: false,
      ready: false,
    };
    await gameRef.update({
      players: FieldValue.arrayUnion(newPlayer),
      // Update TTL when player joins
      ttl: getTTLTimestamp(),
      lastActivity: FieldValue.serverTimestamp(),
    });
    await upsertConnectionIndex(connectionId, gameCode);
    return { player: newPlayer, isNew: true };
  }
}

export async function setPlayerReady(gameCode, playerId) {
  const gameRef = db
    .collection(FIRESTORE_CONFIG.GAMES_COLLECTION)
    .doc(gameCode);

  let allReady = false;
  let updatedGameData = null;

  await db.runTransaction(async (transaction) => {
    const gameDoc = await transaction.get(gameRef);
    if (!gameDoc.exists) throw new Error("Game not found");
    const gameData = gameDoc.data();

    let players = gameData.players;
    const playerIndex = players.findIndex((p) => p.id === playerId);
    if (playerIndex === -1) throw new Error("Player not found");

    // Set player to ready
    players[playerIndex].ready = true;
    transaction.update(gameRef, { players });

    const connectedPlayers = players.filter((p) => !p.disconnected);
    // Game can start if at least 2 players are connected and all of them are ready.
    allReady =
      connectedPlayers.length >= 2 && connectedPlayers.every((p) => p.ready);

    updatedGameData = { ...gameData, players };
  });

  return { updatedGameData, allReady };
}

export async function setPlayerDisconnected(gameCode, connectionId) {
  const gameRef = db
    .collection(FIRESTORE_CONFIG.GAMES_COLLECTION)
    .doc(gameCode);

  let updatedPlayers = null; // Will hold the final list if the transaction succeeds

  await db.runTransaction(async (transaction) => {
    const gameDoc = await transaction.get(gameRef);
    if (!gameDoc.exists) {
      console.log(`Game ${gameCode} not found during disconnect handling.`);
      return; // Abort – nothing to update
    }

    const data = gameDoc.data();
    let players = data.players || [];

    // Find the player **by the exact connectionId we are disconnecting**
    const playerIndex = players.findIndex(
      (p) => p.connectionId === connectionId
    );

    // If the player is not found, it likely means they have already re-joined
    // with a new socket and the connectionId has changed. In that case we do
    // nothing – this prevents us from incorrectly flagging them as disconnected
    // after they have already reconnected.
    if (playerIndex === -1) {
      return; // Abort transaction – no update necessary
    }

    const playerToDisconnect = players[playerIndex];
    console.log(`Disconnecting player: ${playerToDisconnect.displayName}`);

    // Mark the player as disconnected and clear their connectionId
    players[playerIndex] = {
      ...playerToDisconnect,
      disconnected: true,
      connectionId: null,
    };

    // Update TTL when there's activity (even disconnection)
    const updateData = {
      players,
      ttl: getTTLTimestamp(),
      lastActivity: FieldValue.serverTimestamp(),
    };

    // Persist the changes atomically
    transaction.update(gameRef, updateData);
    updatedPlayers = players; // Save for return value outside the transaction
  });

  // Remove the old socket from the connection index
  await deleteConnectionIndex(connectionId);

  return updatedPlayers; // May be null if no changes were necessary
}

export async function removePlayer(gameCode, connectionId) {
  const gameRef = db
    .collection(FIRESTORE_CONFIG.GAMES_COLLECTION)
    .doc(gameCode);
  const gameDoc = await gameRef.get();
  if (!gameDoc.exists) return null;

  let players = gameDoc.data().players;
  const playerToRemove = players.find((p) => p.connectionId === connectionId);
  if (!playerToRemove) return players; // Player already removed

  let updatedPlayers = players.filter((p) => p.connectionId !== connectionId);
  if (updatedPlayers.length === 0) {
    // Optional: Delete the game if everyone leaves
    await gameRef.delete();
    await deleteConnectionIndex(connectionId);
    return [];
  } else {
    await gameRef.update({ players: updatedPlayers });
    await deleteConnectionIndex(connectionId);
    return updatedPlayers;
  }
}

export async function updatePlayer(gameCode, playerId, updates) {
  // Do not proceed if there are no more updates to apply
  if (Object.keys(updates).length === 0) {
    return await getGameData(gameCode);
  }

  const gameRef = db
    .collection(FIRESTORE_CONFIG.GAMES_COLLECTION)
    .doc(gameCode);
  const gameDoc = await gameRef.get();
  if (!gameDoc.exists) throw new Error("Game not found");

  const players = gameDoc.data().players;
  const playerIndex = players.findIndex((p) => p.id === playerId);
  if (playerIndex === -1) throw new Error("Player not found");

  // Merge updates into the player object
  players[playerIndex] = { ...players[playerIndex], ...updates };

  await gameRef.update({
    players: players,
    // Update TTL when player updates
    ttl: getTTLTimestamp(),
    lastActivity: FieldValue.serverTimestamp(),
  });

  // Return fresh game data (callers can reuse this to avoid extra reads)
  return await getGameData(gameCode);
}

export async function startGame(gameCode, gameSeed) {
  const gameRef = db
    .collection(FIRESTORE_CONFIG.GAMES_COLLECTION)
    .doc(gameCode);

  // Use a transaction to atomically read the game state and update it.
  await db.runTransaction(async (transaction) => {
    const gameDoc = await transaction.get(gameRef);
    if (!gameDoc.exists) throw new Error("Game not found");
    const gameData = gameDoc.data();

    // --- Validation ---
    const connectedPlayers = gameData.players.filter((p) => !p.disconnected);
    if (connectedPlayers.length < 2) {
      throw new Error("A multiplayer game requires at least 2 players.");
    }

    // --- Update Game State ---
    const currentGameParticipants = connectedPlayers.map((p) => p.id);
    const gameStartTime = FieldValue.serverTimestamp();

    const players = gameData.players.map((p) => {
      if (!p.disconnected) {
        return {
          ...p,
          inGame: true,
        };
      }
      return p;
    });

    transaction.update(gameRef, {
      state: "playing",
      gameSeed: gameSeed,
      players,
      currentGameParticipants: currentGameParticipants,
      gameStartTime: gameStartTime,
      lastGameEnd: FieldValue.delete(),
      lastGameEndTimestamp: FieldValue.delete(),
      ttl: getTTLTimestamp(),
      lastActivity: FieldValue.serverTimestamp(),
    });
  });
}

// Function to calculate current game time in seconds for timer synchronization
export function calculateCurrentGameTime(gameStartTime) {
  if (!gameStartTime) {
    return 0; // Game hasn't started yet
  }
  // Convert Firestore timestamp to Date if needed
  const startTime = gameStartTime.toDate
    ? gameStartTime.toDate()
    : new Date(gameStartTime);
  const now = new Date();
  // Calculate elapsed time in milliseconds since game start
  const elapsedMs = now.getTime() - startTime.getTime();
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  // Return the raw elapsed time. The client will handle any animation offset.
  return Math.max(0, elapsedSeconds);
}

export async function endGame(gameCode, winnerId, condensedGrid) {
  const gameRef = db
    .collection(FIRESTORE_CONFIG.GAMES_COLLECTION)
    .doc(gameCode);

  const gameDoc = await gameRef.get();
  if (!gameDoc.exists) throw new Error("Game not found");

  const winner = gameDoc.data().players.find((p) => p.id === winnerId);
  if (!winner) throw new Error("Winner not found");

  // Calculate the server time based on game start time
  const gameData = gameDoc.data();
  const serverTimeSeconds = calculateCurrentGameTime(gameData.gameStartTime);

  // Format time as "M:SS" like the client was doing
  const minutes = Math.floor(serverTimeSeconds / 60);
  const remainingSeconds = serverTimeSeconds % 60;
  const formattedTime = `${minutes}:${remainingSeconds
    .toString()
    .padStart(2, "0")}`;

  // This update must be atomic. We use a transaction.
  const updatedGameData = await db.runTransaction(async (transaction) => {
    const freshGameDoc = await transaction.get(gameRef);
    if (freshGameDoc.data().state !== "playing") {
      // Another player already won
      throw new Error("Game has already ended.");
    }

    const currentData = freshGameDoc.data();

    // Update win counts and inGame status for all players in the lobby
    const updatedPlayers = currentData.players.map((p) => ({
      ...p,
      inGame: false,
      ready: false,
      winCount: p.id === winnerId ? (p.winCount || 0) + 1 : p.winCount || 0,
    }));

    // Simplified game end data for storage (no participant list needed)
    const gameEndData = {
      winner: winnerId,
      winnerDisplayName: winner.displayName,
      winnerEmoji: winner.playerEmoji,
      winnerColor: winner.playerColor,
      condensedGrid: JSON.stringify(condensedGrid), // Convert to string for Firestore
      time: formattedTime, // Use server-calculated time
      endedAt: FieldValue.serverTimestamp(),
    };

    // Clear the current game participants list and store the game end data
    transaction.update(gameRef, {
      state: "waiting",
      players: updatedPlayers,
      currentGameParticipants: FieldValue.delete(),
      gameStartTime: FieldValue.delete(), // Clear the game start time
      lastGameEnd: gameEndData,
      lastGameEndTimestamp: FieldValue.serverTimestamp(),
      // Update TTL when game ends
      ttl: getTTLTimestamp(),
      lastActivity: FieldValue.serverTimestamp(),
    });

    // Return the full updated game state with the new player list
    return {
      ...currentData,
      state: "waiting",
      players: updatedPlayers,
    };
  });

  return {
    updatedGame: updatedGameData,
    winner,
    winTime: formattedTime, // Return the server-calculated time
  };
}

/**
 * Assemble a server-authoritative snapshot of current game state.
 * Accepts optional pre-fetched gameData to avoid an extra read.
 */
export async function assembleGameStateSnapshot(gameCode, prefetchedGameData) {
  const gameData = prefetchedGameData || (await getGameData(gameCode));
  if (!gameData) return null;

  const snapshot = {
    phase: "LOBBY",
    gameCode: gameData.gameCode,
    players: gameData.players || [],
  };

  if (gameData.state === "playing") {
    snapshot.phase = "IN_GAME";
    snapshot.gameData = {
      gameSeed: gameData.gameSeed,
      serverElapsedTimeSeconds: calculateCurrentGameTime(
        gameData.gameStartTime
      ),
    };
  } else if (gameData.state === "waiting" && gameData.lastGameEnd) {
    snapshot.phase = "POST_GAME";
    const postGameData = {
      ...gameData.lastGameEnd,
      condensedGrid: [],
      lastGameEndTimestamp: undefined,
    };
    try {
      postGameData.condensedGrid = JSON.parse(
        gameData.lastGameEnd.condensedGrid
      );
    } catch {
      postGameData.condensedGrid = [];
    }
    postGameData.lastGameEndTimestamp =
      gameData.lastGameEndTimestamp?.toDate?.() ?? null;
    snapshot.postGameData = postGameData;
  } else {
    snapshot.phase = "LOBBY";
  }

  return snapshot;
}
