'use strict';

// Tiny gRPC client — bundled so you can call gRPC without installing grpcurl.
// Run it INSIDE the container:  docker compose exec api node client.js [id]
// It dials the server on localhost:50051, calls GetUser, and prints the reply.

const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const packageDefinition = protoLoader.loadSync(path.join(__dirname, 'user.proto'), {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});
const userProto = grpc.loadPackageDefinition(packageDefinition).user;

const client = new userProto.UserService(
  'localhost:50051',
  grpc.credentials.createInsecure()
);

const id = process.argv[2] || '1';

client.GetUser({ id }, (err, response) => {
  if (err) {
    console.error('gRPC error:', err.code, err.message);
    process.exit(1);
  }
  // Over the wire this was compact binary; here it is decoded back into an object.
  console.log(JSON.stringify(response, null, 2));
});
