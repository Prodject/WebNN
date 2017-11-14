const
FS = require("fs"),
SERVER = require("./Server"),
READLINE = require("readline"),
UUID = (function(){
	var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
				 + "abcdefghijklmnopqrstuvwxyz"
				 + "0123456789";
	return function(length) {
		var id = "";
		length = length || 5;
		while (length--) {
			id += possible.charAt(Math.random() * 62 >> 0);
		}
		return id;
	};
})(),
MERGER = require("./merge"),
VALIDATOR = require("./validate");
//fork = require("child-process").fork;

var
sinceRefresh = {},
currentModel = {},
trainingMeta = {},
modelPath = "",
num_clients = 0,
paths = {},
Merger = null,
Validator = null,
longPoll = null,
shouldQuit = false,

refreshServer = function() {
	longPoll.writeHead(200, {"Content-Type": "application/json"});
	longPoll.write(JSON.stringify(sinceRefresh));
	longPoll.end();
	sinceRefresh = {};
	longPoll = null;
},

loadLogs = function() {
	// get logs for currentModel and send data to Master
	var log_directory = "./models/" + currentModel.model + "/version/" + currentModel.version + "/logs/";
	//console.log("sinceRefresh: " + sinceRefresh);
	FS.readdir(log_directory, function(error, files) {
		if (error) throw error;
		var length = files.length;

		if (length == 1) return;

		sinceRefresh = {};

		files.forEach(function(filename, index) {
			if (filename === ".DS_Store") {
				length--;
				return;
			}

			sinceRefresh[filename] = [];

			var rl, firstLine = true;

			rl = READLINE.createInterface({
				input : FS.createReadStream(log_directory + filename),
				terminal: false
			});

			rl.on('close', function() {
				length--;
				if (length === 0) {
					refreshServer();
				}
			});

			rl.on('line', function(line) {
				if (firstLine) {
					firstLine = false;
					return;
				}
				line = line.split(",");
				sinceRefresh[filename].push({x: Number(line[0]), y: Number(line[1])});
			});
		});
	});
},

Routes = {

// MASTER ROUTES //////////////////////////////////////////////////////////////
	"/master": { // get master interface
		"GET": function(request, response, verbose) {
			FS.readFile('./master/master.html', 'utf8', function(error, data) {
				if (error) throw error;
				else {
					response.writeHead(200, {"Content-Type": "text/html"});
					response.write(data);
					response.end();
				}
			});
		}
	},
	"/master.js": { // get master.js
		"GET": function(request, response, verbose) {
			FS.readFile('./master/master.js', 'utf8', function(error, data) {
				if (error) throw error;
				else {
					response.writeHead(200, {"Content-Type": "text/js"});
					response.write(data);
					response.end();
				}
			});
		}
	},
	"/train": { // request model to be the one trained
		"PUT": function(request, response, verbose) {
			var train = JSON.parse(request.body),
				data;
			modelPath = "./models/" + train.model + "/version/" + train.version + "/";
			// TODO: save currentModel to disk if switching

			// loading in training metadata
			if (FS.existsSync(modelPath + "training.json")) data = FS.readFileSync(modelPath + "training.json", 'utf8');
			else data = FS.readFileSync("./models/" + train.model + "/training.json");
			trainingMeta = JSON.parse(data);
			
			Validator = new VALIDATOR(modelPath, "./models/" + train.model + "/test/", null, trainingMeta);
			if (trainingMeta.weights_version === -1) {
				// write random weights to disk
				FS.writeFileSync(modelPath + "weights", Buffer.from(Validator.save()), "binary");
				trainingMeta.weights_version = 0;
			}
			//if (Merger !== null) Merger.save();
			Merger = new MERGER(modelPath + "weights", 10);

			data = FS.readFileSync(modelPath + "model.json", 'utf8');
			currentModel = JSON.parse(data);
			console.log(currentModel.model + " version: " + currentModel.version + "\n");
			response.writeHead(200);
			response.end();
			loadLogs();
		},
		"GET": function(request, response, verbose) {
			longPoll = response;
		}
	},
	"/stop": {
		"PUT": function(request, response, verbose) {
			shouldQuit = true;
			onStop();
		}
	},

// CLIENT ROUTES //////////////////////////////////////////////////////////////
	"/": {
		"GET": function(request, response, verbose) {
			FS.readFile('./client/client.html', 'utf8', function(error, data) {
				if (error) throw error;
				else {
					response.writeHead(200, {"Content-Type": "text/html"});
					response.write(data);
					response.end();
				}
			});
		}
	},
	"/calculon.jpg": { // get image
		"GET": function(request, response, verbose) {
			FS.readFile('./client/calculon.jpg', function(error, data) {
				if (error) throw error;
				else {
					response.writeHead(200, {"Content-Type": "image/jpeg"});
					response.write(data);
					response.end();
				}
			});
		}
	},
	"/calculon.js": { // get client-side script
		"GET": function(request, response, verbose) {
			FS.readFile('./client/calculon.js', 'utf8', function(error, data) {
				if (error) throw error;
				else {
					response.writeHead(200, {"Content-Type": "text/js"});
					response.write(data);
					response.end();
				}
			});
		}
	},
	"/model": { // get the current model to train
		"GET": function(request, response, verbose) {
			
			var id = UUID();

			paths[id] = {
				weights_version: trainingMeta.weights_version,
				data: "./models/" + currentModel.model + "/data/",
				path: "./models/" + currentModel.model + "/version/" + currentModel.version + "/",
				log: "./models/" + currentModel.model + "/version/" + currentModel.version + "/logs/" + id
			};

			currentModel.id = id;
			currentModel.weights_version = trainingMeta.weights_version;
			num_clients++;
			CreateRoutes(id, currentModel.model, currentModel.version);

			response.writeHead(200, {"Content-Type": "application/json"});
			response.write( JSON.stringify(currentModel) );
			response.end();
		}
	}
},

DeleteRoutes = function(id) {
	// remove routes
	delete Routes["/model/" + id];
	delete Routes["/log/" + id];
	delete Routes["/data/" + id];
	delete Routes["/close/" + id];

	num_clients--;
	paths[id] = undefined;
},

CreateRoutes = function(id) {

	Routes["/data/" + id] = { // get data for the model
		"GET": function(request, response, verbose) {
			// data: <Buffer> [ batchSize, batchX, batchY ]
			trainingMeta.last_training++;
			if (trainingMeta.last_training === trainingMeta.training_minibatches) {
				trainingMeta.last_training = 0;
				trainingMeta.epochs_trained++;
			}
			FS.readFile(paths[id].data + trainingMeta.last_training, function(error, data) {
				if (error) throw error;
				else {
					response.writeHead(200, {"Content-Type": "arraybuffer"});
					response.write(data);
					response.end();
				}
			});
		}
	};

	Routes["/close/" + id] = { // done training
		"POST": function(request, response, verbose) {
			
			DeleteRoutes(id);

			response.writeHead(200);
			response.end();
		}
	};

	Routes["/weights/" + id] = {
		"GET": function(request, response, verbose) {
			// send weights for layers
			// data: <Buffer> [ ...layers ]
			response.writeHead(200, {"Content-Type": "arraybuffer"});
			response.write(Buffer.from(Merger.weights.read().data.buffer));
			response.end();
		},
		"PUT": function(request, response, verbose) {
			var staleness;

			if (!paths[id]) {
				response.end();
				return;
			}

			staleness = (trainingMeta.weights_version - paths[id].weights_version) + 1; // staleness >= 1
			// integrate data into model
			Merger.merge(new Float32Array(new Uint8Array(request.body).buffer), ( 1 / (staleness * num_clients)));
			
			if (!shouldQuit) {
				response.writeHead(200, {"Content-Type": "arraybuffer"});
				response.write(Buffer.from(Merger.weights.read().data.buffer));
				
			}
			response.end();
			
			trainingMeta.weights_version++;
			paths[id].weights_version = trainingMeta.weights_version;
			if (Merger.shouldValidate) Validator.validateWeights(Merger.weights.read().data, function(loss) {
				if (!paths[id]) return;
				FS.appendFile(paths[id].path + "logs/validation", ( trainingMeta.weights_version + "," + loss + "," + (new Date()).toISOString() + "\n" ), function(error) { if (error) throw error; });
				sinceRefresh["validation"] = sinceRefresh["validation"] || [];
				sinceRefresh["validation"].push({x: trainingMeta.weights_version, y: loss});
			});

			if (shouldQuit) DeleteRoutes(id);
		}
	};

	Routes["/log/" + id] = {
		"PUT": function(request, response, verbose) {
			FS.appendFile(paths[id].path + "logs/" + id, request.body, function(error) {
				if (error) throw error;
				else {
					FS.appendFile(paths[id].path + "logs/" + id, ( "," + (new Date()).toISOString() + "\n" ), function(error) { if (error) throw error; });
					var line;
					response.writeHead(200);
					response.end();

					sinceRefresh[id] = sinceRefresh[id] || [];
					line = request.body.toString().toString().split(",");
					sinceRefresh[id].push({x: Number(line[0]), y: Number(line[1])});
					if (longPoll !== null) refreshServer();
				}
			});
		}
	}
},

onStop = function() {
	Merger.save();
	Server.stop();
	FS.writeFileSync(modelPath + "training.json", JSON.stringify(trainingMeta), "utf8");
	if (longPoll) longPoll.end();
	console.log("Goodbye.");
	process.exit();
};

const Server = new SERVER(25735, Routes, true);
Server.start();

// I read that this doesn't work on Windows (but did not verify)
process.on('SIGINT', onStop);