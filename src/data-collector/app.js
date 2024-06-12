const fs = require("fs");
const Influx = require("influx");
const mqtt = require("mqtt");
const express = require("express");
const cors = require("cors");
const WebSocket = require('ws');
const app = express();
const server = require('http').createServer(app);
const PORT = 8000;

const pathConfig = '/cfg-data/env-config.json';

let configbuffer = fs.readFileSync(pathConfig);
console.log("configbuffer: " + configbuffer);
envconfig = JSON.parse(configbuffer);

const MQTT_IP = envconfig.env.MQTT_BROKER_SERVER || 'ie-databus';
const MQTT_TOPIC = envconfig.env.MQTT_TOPIC || 'ie/d/j/simatic/v1/s7c1/dp/r/';
const DATA_SOURCE_NAME = envconfig.env.DATA_SOURCE_NAME || 'PLC_1/default';
const MQTT_USER = envconfig.env.MQTT_USER || 'edge';
const MQTT_PASSWORD = envconfig.env.MQTT_PASSWORD || 'edge';
const INFLUXDB_IP = envconfig.env.INFLUXDB_IP || 'influxdb';
const INFLUXDB_DATABASE = envconfig.env.INFLUXDB_DATABASE || 'databus_values';

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());

const options = {
  clientId: "mqttjs_" + Math.random().toString(16).slice(2, 10),
  protocolId: "MQTT",
  'username': MQTT_USER,
  'password': MQTT_PASSWORD
};

const client = mqtt.connect('mqtt://' + MQTT_IP, options);
// let client;

// try {
//   client = mqtt.connect('mqtt://' + MQTT_IP, options);
//   console.log("Connected to MQTT Broker:" + MQTT_IP);
// } catch(error) {
//   console.error("Error in connecting broker:", error);
// }

let isInfluxDBReady = false;
const wss = new WebSocket.Server({ server });

client.on("connect", () => {
  console.log("Connected to " + MQTT_IP);
  client.subscribe(MQTT_TOPIC+DATA_SOURCE_NAME, (err) => {
    if (err) {
      console.error("Failed to subscribe to " + MQTT_TOPIC + +DATA_SOURCE_NAME + ":", err);
    } else {
      console.log("Subscribed to " + MQTT_TOPIC +DATA_SOURCE_NAME);
    }
  });
});

const influx = new Influx.InfluxDB({
  host: INFLUXDB_IP,
  database: INFLUXDB_DATABASE,
  port: 8086,
  username: "root",
  password: "root",
  schema: [
    {
      measurement: "sensor_data",
      fields: {
        value: Influx.FieldType.FLOAT,
      },
      tags: [
        "host"
      ],
    },
  ],
});

async function setupInfluxDB() {
  try {
    const names = await influx.getDatabaseNames();
    if (!names.includes(INFLUXDB_DATABASE)) {
      await influx.createDatabase(INFLUXDB_DATABASE);
      console.log(`Database "${INFLUXDB_DATABASE}" created`);
      isInfluxDBReady = true;
    } else {
      console.log(`Database "${INFLUXDB_DATABASE}" already exists`);
      isInfluxDBReady = true;
    }
  } catch (err) {
    console.error("Error setting up InfluxDB:", err);
  }
}
//timer set:
  setTimeout(setupInfluxDB, 12000);
//timer not set: 
  //setupInfluxDB();

// async function createDatabase() {
//   await influx.createDatabase(INFLUXDB_DATABASE)
//   console.log("database created");
// }
// setTimeout(createDatabase, 12000);

client.on("message", async (topic, message) => {
  console.log("Received message on topic:", topic);
  try {
    const msg = message.toString();
    const jsonmsg = JSON.parse(msg);
    console.log("Message content:", jsonmsg);

    for (const element of jsonmsg.vals) {
      await influx.writePoints([
        {
          measurement: "sensor_data",
          tags: { host: element.host },
          fields: { value: Number(element.val) },
        },
      ]);

      const query = `
        SELECT * FROM sensor_data
        WHERE host = '${element.host}'
        ORDER BY time DESC
        LIMIT 1`;

      const result = await influx.query(query);
      if (result.length > 0) {
        const latestEntry = result[0];
        const broadcastMessage = {
          time: latestEntry.time.toISOString(),
          id: latestEntry.host,
          value: latestEntry.value
        };
        console.log(broadcastMessage);
        broadcastMessageToClients(broadcastMessage);
      }
    }
  } catch (error) {
    console.error("Error processing message:", error);
  }
});

wss.on('connection', async (ws) => {
  if (!isInfluxDBReady) {
    console.log("InfluxDB is not ready yet. Closing WebSocket connection.");
    ws.close();
    return;
  }
  console.log('New WebSocket connection');
  try {
    // Fetch initial data
    const initialQuery = 'SELECT * FROM sensor_data';
    const initialData = await influx.query(initialQuery);
    const formattedData = initialData.map(entry => ({
      time: entry.time.toISOString(),
      id: entry.host,
      value: entry.value
    }));
    // Send initial data to the new client
    ws.send(JSON.stringify(formattedData));
  } catch (error) {
    console.error("Error fetching initial data:", error);
  }

  ws.on('close', () => {
    console.log('WebSocket connection closed');
  });
});

app.get("/", async (req, res) => {
  const initialQuery = 'SELECT * FROM sensor_data';
    const initialData = await influx.query(initialQuery);
    const formattedData = initialData.map(entry => ({
      time: entry.time.toISOString(),
      id: entry.host,
      value: entry.value
    }));
    // Send initial data to the new client
    res.send(JSON.stringify(formattedData));
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

function broadcastMessageToClients(message) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}
