const WebSocket = require('ws');
const axios = require('axios');
const readline = require('readline');
require('colors');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const config = {
  userId: 805194544,
  userLogin: 'login_v2',
  userSecretKey: 'acf0b652da831a6cc6a83b9e63ecde989c7688edf1eb52bb2c1b66aa12a91205',
  betAmount: null,
  shouldReconnect: true,
  maxRetries: 5,
  retryCount: 0,
  reconnectDelay: 3,
  apiTimeout: 5000,
  roomNames: {
    1: 'Utilitas', 2: 'Rapat', 3: 'Direktur', 4: 'Diskusi',
    5: 'Pemantauan', 6: 'Kerja', 7: 'Keuangan', 8: 'HRD'
  },
  betHistory: [],
  killHistory: [],
  ws: null,
  lastActivity: Date.now(),
  currentCountdown: 0,
  currentIssueId: null,
  lastBetIssueId: null
};

const authHeaders = {
  'user-id': config.userId,
  'user-login': config.userLogin,
  'user-secret-key': config.userSecretKey,
  'content-type': 'application/json'
};

async function main() {
  config.betAmount = await getValidBetAmount();
  
  while (config.shouldReconnect && config.retryCount < config.maxRetries) {
    try {
      await connectAndListen();
      await delay(config.reconnectDelay * 1000);
    } catch (error) {
      handleConnectionError(error);
    }
  }
  exitWithError('❌ Batas maksimum retry tercapai');
}

async function getValidBetAmount() {
  const input = await new Promise(resolve => 
    rl.question('💰 Masukkan jumlah taruhan: ', resolve)
  );
  const amount = parseInt(input);
  
  if (isNaN(amount)) {
    exitWithError('❌ Harap masukkan angka yang valid');
  }
  
  rl.close();
  return amount;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function exitWithError(message) {
  console.log(message.red);
  process.exit(1);
}

async function connectAndListen() {
  return new Promise(async (resolve, reject) => {
    try {
      config.ws = new WebSocket('wss://api.escapemaster.net/escape_master/ws');
      
      config.ws.on('open', async () => {
        console.log('🟢 Terhubung ke server'.green);
        config.retryCount = 0;
        await authenticate();
        startHeartbeat();
        resolve();
      });

      config.ws.on('message', handleIncomingMessage);
      config.ws.on('close', handleConnectionClose(reject));
      config.ws.on('error', handleConnectionError);

    } catch (error) {
      reject(error);
    }
  });
}

async function authenticate() {
  const authData = {
    msg_type: "handle_enter_game",
    asset_type: "BUILD",
    user_id: config.userId,
    user_secret_key: config.userSecretKey
  };
  config.ws.send(JSON.stringify(authData));
}

function handleIncomingMessage(message) {
  config.lastActivity = Date.now();
  const data = JSON.parse(message.toString());

  updateIssueInfo(data);
  handleRoomDestruction(data);
  processRoomData(data);
}

function updateIssueInfo(data) {
  if (typeof data.issue_id !== 'undefined') {
    config.currentIssueId = data.issue_id;
  }
  if (typeof data.count_down !== 'undefined') {
    config.currentCountdown = data.count_down;
  }
}

function handleRoomDestruction(data) {
  if (data.msg_type === "notify_result" && data.killed_room) {
    const killedRooms = Array.isArray(data.killed_room) ? data.killed_room : [data.killed_room];
    killedRooms.forEach(processKilledRoom);
  }
}

function processKilledRoom(roomId) {
  const roomName = config.roomNames[roomId];
  console.log(`💥 Ruangan ${roomName} hancur!`.red);
  
  config.killHistory.unshift({
    timestamp: new Date().toLocaleTimeString(),
    room: roomName,
    issueId: config.currentIssueId
  });
  
  if (config.killHistory.length > 5) config.killHistory.pop();
  reconnect();
}

function processRoomData(data) {
  if (data.rooms) {
    const rooms = mapRoomData(data.rooms);
    
    if (shouldPlaceBet()) {
      executeBettingStrategy(rooms);
      config.lastBetIssueId = config.currentIssueId;
    }
    
    updateDashboard(rooms);
  }
}

function shouldPlaceBet() {
  return (
    config.currentCountdown === 3 && 
    config.currentIssueId !== config.lastBetIssueId
  );
}

async function executeBettingStrategy(rooms) {
  const filteredRooms = filterActiveRooms(rooms);
  const sortedRooms = sortRoomsByRatio(filteredRooms);
  
  if (sortedRooms.length === 0) return;

  const targetRoom = sortedRooms[0];
  try {
    await enterRoom(targetRoom.id);
    await placeBet(targetRoom.id);
    logBetResult(targetRoom, true);
  } catch (error) {
    logBetResult(targetRoom, false, error.message);
  }
}

function filterActiveRooms(rooms) {
  return rooms.filter(room => 
    !isRecentlyKilled(room.name) && 
    room.users > 0 &&
    room.ratio !== Infinity
  );
}

function isRecentlyKilled(roomName) {
  return config.killHistory.some(entry => entry.room === roomName);
}

function sortRoomsByRatio(rooms) {
  return [...rooms].sort((a, b) => b.ratio - a.ratio);
}

async function enterRoom(roomId) {
  try {
    await axios.post(
      'https://api.escapemaster.net/escape_game/enter_room',
      {
        asset_type: "BUILD",
        user_id: config.userId,
        room_id: roomId
      },
      {
        headers: authHeaders,
        timeout: config.apiTimeout
      }
    );
  } catch (error) {
    throw new Error(`Gagal masuk ruangan: ${error.response?.data?.message || error.message}`);
  }
}

async function placeBet(roomId) {
  try {
    const response = await axios.post(
      'https://api.escapemaster.net/escape_game/bet',
      {
        asset_type: "BUILD",
        user_id: config.userId,
        bet_amount: config.betAmount,
        room_id: roomId
      },
      {
        headers: authHeaders,
        timeout: config.apiTimeout
      }
    );

    if (response.data.code !== 0) {
      throw new Error(response.data.message);
    }
  } catch (error) {
    throw new Error(`Gagal taruhan: ${error.response?.data?.message || error.message}`);
  }
}

function updateDashboard(rooms) {
  console.clear();
  showHeader();
  showRoomTable(rooms);
  showDestructionHistory();
  showBetHistory();
}

function showHeader() {
  console.log('=== LIVE DASHBOARD ==='.cyan);
  console.log(`🕒 Countdown: ${config.currentCountdown}s | 💰 Taruhan: ${config.betAmount}\n`);
}

function showRoomTable(rooms) {
  console.log('=== DAFTAR RUANGAN (Rasio Tertinggi ke Terendah) ==='.green);
  console.table(sortRoomsByRatio(rooms).map(formatRoomForTable));
}

function formatRoomForTable(room) {
  return {
    ID: room.id,
    Nama: room.name,
    Pengguna: room.users,
    'Total Taruhan': room.totalBet,
    Rasio: room.ratio.toFixed(2)
  };
}

function showDestructionHistory() {
  console.log('\n=== 5 PENGHANCURAN TERAKHIR ==='.red);
  console.table(config.killHistory.slice(0, 5).map(formatDestructionEntry));
}

function formatDestructionEntry(entry) {
  return {
    Waktu: entry.timestamp,
    Ruangan: entry.room,
    IssueID: entry.issueId,
    Status: 'DIBUNUH 💀'
  };
}

function showBetHistory() {
  console.log('\n=== 5 TARUHAN TERAKHIR ==='.green);
  console.table(config.betHistory.slice(0, 5).map(formatBetEntry));
}

function formatBetEntry(entry) {
  return {
    Waktu: entry.waktu,
    Ruangan: entry.ruangan,
    IssueID: entry.issueId,
    Status: entry.status,
    Rasio: entry.rasio
  };
}

function logBetResult(room, isSuccess, errorMessage = '') {
  const entry = {
    waktu: new Date().toLocaleTimeString(),
    ruangan: room.name,
    issueId: config.currentIssueId,
    status: isSuccess ? 'BERHASIL ✅' : `GAGAL ❌ (${errorMessage})`,
    rasio: room.ratio.toFixed(2)
  };

  config.betHistory.unshift(entry);
  if (config.betHistory.length > 5) config.betHistory.pop();
}

function handleConnectionClose(reject) {
  return () => {
    console.log('🔴 Koneksi ditutup, mencoba ulang...'.yellow);
    config.shouldReconnect = true;
    reject(new Error('Connection closed'));
  };
}

function handleConnectionError(error) {
  console.error(`[ERROR] ${error.message}`.red);
  config.retryCount++;
}

function reconnect() {
  config.ws.close();
  config.shouldReconnect = true;
}

function startHeartbeat() {
  setInterval(() => {
    const inactiveTime = Date.now() - config.lastActivity;
    if (inactiveTime > 30000) {
      console.log('💓 Mengirim heartbeat...'.gray);
      config.ws.send(JSON.stringify({ msg_type: "heartbeat" }));
    }
  }, 10000);
}

function mapRoomData(rooms) {
  return rooms.map(room => ({
    id: room.room_id,
    name: config.roomNames[room.room_id],
    users: room.user_cnt,
    totalBet: room.total_bet_amount,
    ratio: calculateRatio(room.user_cnt, room.total_bet_amount)
  }));
}

function calculateRatio(users, totalBet) {
  return users > 0 ? totalBet / users : Infinity;
}

main().catch(console.error);
