const WebSocket = require('ws');
const axios = require('axios');
const readline = require('readline');
require('colors');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Configuration with multiple accounts
const config = {
  // Primary account used for WebSocket connection
  primaryAccount: {
    userId: 805252744,
    userLogin: 'login_v2',
    userSecretKey: 'bd246893bda42b179bf7287482edd1aa93933198c4deb458e98269d83ab572af',
  },
  // All accounts that will place bets
  accounts: [
    {
      userId: 805252744,
      userLogin: 'login_v2',
      userSecretKey: 'bd246893bda42b179bf7287482edd1aa93933198c4deb458e98269d83ab572af',
      betHistory: [],
      lastBetIssueId: null
    },
    {
      userId: 805274136,
      userLogin: 'login_v2',
      userSecretKey: '0c231822fa968a051cd9a4571c708b5da065fc6bc435248c96a5a6ba177bc4a6',
      betHistory: [],
      lastBetIssueId: null
    },
    {
      userId: 805271139,
      userLogin: 'login_v2',
      userSecretKey: 'e0fb9ed569d1b820d85d54274cba3be8801d7f99f7edf29b6ae7b3dfc1dffc54',
      betHistory: [],
      lastBetIssueId: null
    },
    {
      userId: 804804161,
      userLogin: 'login_v2',
      userSecretKey: '9d7f44620f31badac67536dfd694cb6420628e2951b7a69146f66324c98fbf6d',
      betHistory: [],
      lastBetIssueId: null
    }
  ],
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
  killHistory: [],
  ws: null,
  lastActivity: Date.now(),
  currentCountdown: 0,
  currentIssueId: null
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
  // Authenticate only the primary account for WebSocket connection
  const authData = {
    msg_type: "handle_enter_game",
    asset_type: "BUILD",
    user_id: config.primaryAccount.userId,
    user_secret_key: config.primaryAccount.userSecretKey
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
      executeBettingStrategyForAllAccounts(rooms);
    }
    
    updateDashboard(rooms);
  }
}

function shouldPlaceBet() {
  return config.currentCountdown === 10; // We'll check individual accounts in the execution
}

async function executeBettingStrategyForAllAccounts(rooms) {
  const filteredRooms = filterActiveRooms(rooms);
  const sortedRooms = sortRoomsByRatio(filteredRooms);
  
  if (sortedRooms.length === 0) return;

  // Get the target room with the highest ratio
  const targetRoom = sortedRooms[0];

  // Execute bets for all accounts
  for (const account of config.accounts) {
    // Skip if this account already bet on this issue
    if (account.lastBetIssueId === config.currentIssueId) {
      continue;
    }

    try {
      // Create headers for this specific account
      const authHeaders = {
        'user-id': account.userId,
        'user-login': account.userLogin || 'login_v2',
        'user-secret-key': account.userSecretKey,
        'content-type': 'application/json'
      };

      await enterRoom(targetRoom.id, account.userId, authHeaders);
      await placeBet(targetRoom.id, account.userId, authHeaders);
      
      // Log successful bet
      logBetResult(account, targetRoom, true);
      
      // Update the last bet issue ID for this account
      account.lastBetIssueId = config.currentIssueId;
    } catch (error) {
      // Log failed bet
      logBetResult(account, targetRoom, false, error.message);
    }
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

async function enterRoom(roomId, userId, headers) {
  try {
    await axios.post(
      'https://api.escapemaster.net/escape_game/enter_room',
      {
        asset_type: "BUILD",
        user_id: userId,
        room_id: roomId
      },
      {
        headers: headers,
        timeout: config.apiTimeout
      }
    );
  } catch (error) {
    throw new Error(`Gagal masuk ruangan: ${error.response?.data?.message || error.message}`);
  }
}

async function placeBet(roomId, userId, headers) {
  try {
    const response = await axios.post(
      'https://api.escapemaster.net/escape_game/bet',
      {
        asset_type: "BUILD",
        user_id: userId,
        bet_amount: config.betAmount,
        room_id: roomId
      },
      {
        headers: headers,
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
  showAllAccountsBetHistory();
}

function showHeader() {
  console.log('=== LIVE DASHBOARD (MULTI-ACCOUNT) ==='.cyan);
  console.log(`🕒 Countdown: ${config.currentCountdown}s | 💰 Taruhan: ${config.betAmount}`);
  console.log(`👤 Jumlah Akun: ${config.accounts.length}\n`);
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
  console.log('\n=== 5 RUANGAN TERAKHIR DIBUNUH ==='.red);
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

function showAllAccountsBetHistory() {
  console.log('\n=== RIWAYAT TARUHAN SEMUA AKUN ==='.green);
  
  for (let i = 0; i < config.accounts.length; i++) {
    const account = config.accounts[i];
    console.log(`\n👤 AKUN #${i+1} (${account.userId})`.yellow);
    
    if (account.betHistory.length > 0) {
      console.table(account.betHistory.slice(0, 3).map(formatBetEntry));
    } else {
      console.log('Belum ada riwayat taruhan'.gray);
    }
  }
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

function logBetResult(account, room, isSuccess, errorMessage = '') {
  const entry = {
    waktu: new Date().toLocaleTimeString(),
    ruangan: room.name,
    issueId: config.currentIssueId,
    status: isSuccess ? 'BERHASIL ✅' : `GAGAL ❌ (${errorMessage})`,
    rasio: room.ratio.toFixed(2)
  };

  account.betHistory.unshift(entry);
  if (account.betHistory.length > 5) account.betHistory.pop();
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
