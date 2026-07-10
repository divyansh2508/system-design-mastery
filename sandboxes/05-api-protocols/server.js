'use strict';

// One process, one data store, THREE ways to ask for a user:
//   REST    → GET  http://localhost:3000/users/:id       (Express)
//   GraphQL → POST http://localhost:3000/graphql         (graphql-js)
//   gRPC    → UserService/GetUser on localhost:50051      (@grpc/grpc-js)
//
// The point of the lab is to fetch the SAME record three ways and compare the
// payload shapes: REST always returns the whole object, GraphQL returns exactly
// the fields you asked for, gRPC returns a compact typed binary message.

const path = require('path');
const express = require('express');
const { graphql, buildSchema } = require('graphql');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

// ---------------------------------------------------------------------------
// The shared "database": the single source of truth all three APIs read from.
// ---------------------------------------------------------------------------
const users = {
  '1': { id: '1', name: 'Ada Lovelace',   email: 'ada@analytical.engine', age: 36, city: 'London',     role: 'Mathematician' },
  '2': { id: '2', name: 'Alan Turing',    email: 'alan@bletchley.uk',     age: 41, city: 'Manchester', role: 'Computer Scientist' },
  '3': { id: '3', name: 'Grace Hopper',   email: 'grace@navy.mil',        age: 45, city: 'Arlington',  role: 'Rear Admiral' }
};

// ---------------------------------------------------------------------------
// 1) REST — Express. GET /users/:id returns the ENTIRE user object every time.
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.get('/users/:id', (req, res) => {
  const u = users[req.params.id];
  if (!u) return res.status(404).json({ error: 'user not found' });
  res.json(u); // whole record — the client takes what it gets (possible over-fetch)
});

// ---------------------------------------------------------------------------
// 2) GraphQL — one endpoint, the client declares exactly which fields it wants.
// ---------------------------------------------------------------------------
const schema = buildSchema(`
  type User {
    id: ID!
    name: String!
    email: String!
    age: Int!
    city: String!
    role: String!
  }
  type Query {
    user(id: ID!): User
  }
`);

const root = {
  user: ({ id }) => users[id] || null
};

app.post('/graphql', async (req, res) => {
  const { query, variables } = req.body || {};
  if (!query) return res.status(400).json({ errors: [{ message: 'missing "query"' }] });
  const result = await graphql({
    schema,
    source: query,
    rootValue: root,
    variableValues: variables
  });
  res.json(result); // { data: { user: { ...only requested fields } } }
});

app.listen(3000, () => {
  console.log('REST + GraphQL listening on http://0.0.0.0:3000');
});

// ---------------------------------------------------------------------------
// 3) gRPC — @grpc/grpc-js. Same GetUser call, but typed + compact binary wire.
// ---------------------------------------------------------------------------
const packageDefinition = protoLoader.loadSync(path.join(__dirname, 'user.proto'), {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});
const userProto = grpc.loadPackageDefinition(packageDefinition).user;

function getUser(call, callback) {
  const u = users[call.request.id];
  if (!u) {
    return callback({ code: grpc.status.NOT_FOUND, message: 'user not found' });
  }
  callback(null, u);
}

const grpcServer = new grpc.Server();
grpcServer.addService(userProto.UserService.service, { GetUser: getUser });

// bindAsync auto-starts serving in @grpc/grpc-js >= 1.10 (no server.start() needed).
grpcServer.bindAsync('0.0.0.0:50051', grpc.ServerCredentials.createInsecure(), (err, port) => {
  if (err) {
    console.error('gRPC bind failed:', err);
    process.exit(1);
  }
  console.log('gRPC listening on 0.0.0.0:' + port);
});
