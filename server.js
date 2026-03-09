const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

app.use(express.static(path.join(__dirname)));
app.use(express.json());

// Fallback: serve HTML files for all routes
app.get('/:file', (req, res) => {
    const file = req.params.file;
    const filePath = path.join(__dirname, file);
    if (fs.existsSync(filePath) && filePath.endsWith('.html')) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('Not found');
    }
});

// rooms: Map of roomCode -> Set of WebSocket clients
const rooms = new Map();

function getRoomClients(roomCode) {
    if (!rooms.has(roomCode)) rooms.set(roomCode, new Set());
    return rooms.get(roomCode);
}

function broadcast(roomCode, data, excludeClient = null) {
    const clients = getRoomClients(roomCode);
    const msg = JSON.stringify(data);
    clients.forEach(client => {
        if (client !== excludeClient && client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

// REST: Get recent messages for a room
app.get('/api/messages/:roomCode', async (req, res) => {
    const { roomCode } = req.params;
    try {
        const result = await pool.query(
            'SELECT username, message, created_at FROM chat_messages WHERE room_code = $1 ORDER BY created_at DESC LIMIT 50',
            [roomCode.toUpperCase()]
        );
        res.json(result.rows.reverse());
    } catch (err) {
        console.error('Error fetching messages:', err);
        res.status(500).json({ error: 'Failed to load messages' });
    }
});

// WebSocket connection
wss.on('connection', (ws) => {
    let currentRoom = null;
    let currentUsername = null;

    ws.on('message', async (rawData) => {
        let data;
        try {
            data = JSON.parse(rawData);
        } catch {
            return;
        }

        if (data.type === 'join') {
            const roomCode = (data.roomCode || '').trim().toUpperCase();
            const username = (data.username || 'Anonymous').trim().slice(0, 30);

            if (!roomCode || roomCode.length > 20) {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid room code.' }));
                return;
            }

            currentRoom = roomCode;
            currentUsername = username;
            getRoomClients(roomCode).add(ws);

            ws.send(JSON.stringify({ type: 'joined', roomCode, username }));

            broadcast(roomCode, {
                type: 'system',
                message: `${username} joined the room.`
            }, ws);

        } else if (data.type === 'message') {
            if (!currentRoom || !currentUsername) return;

            const message = (data.message || '').trim().slice(0, 500);
            if (!message) return;

            try {
                await pool.query(
                    'INSERT INTO chat_messages (room_code, username, message) VALUES ($1, $2, $3)',
                    [currentRoom, currentUsername, message]
                );
            } catch (err) {
                console.error('Error saving message:', err);
            }

            const payload = {
                type: 'message',
                username: currentUsername,
                message,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };

            ws.send(JSON.stringify(payload));
            broadcast(currentRoom, payload, ws);
        }
    });

    ws.on('close', () => {
        if (currentRoom) {
            getRoomClients(currentRoom).delete(ws);
            if (getRoomClients(currentRoom).size === 0) {
                rooms.delete(currentRoom);
            } else {
                broadcast(currentRoom, {
                    type: 'system',
                    message: `${currentUsername} left the room.`
                });
            }
        }
    });
});

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log(`Server is running on http://${HOST}:${PORT}`);
    process.on('SIGTERM', () => {
        console.log('SIGTERM received, closing server');
        server.close(() => process.exit(0));
    });
});
