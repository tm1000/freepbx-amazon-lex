//https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/LexRuntime.html

const AWS = require('aws-sdk');
const FreePBX = require("freepbx");
var Promise = require("bluebird")
const FS = Promise.promisifyAll(require("fs"));
const ariclient = require('ari-client')
const RECORDINGS = '/var/spool/asterisk/recording'

const lexruntime = new AWS.LexRuntime({
	apiVersion: '2016-11-28',
	accessKeyId: '<accessKeyId>',
	secretAccessKey: '<secretAccessKey>',
	region: 'us-west-2'
});


FreePBX.connect().then(function (pbx) {
	return Promise.all([
		pbx.config.get("HTTPBINDPORT"),
		pbx.config.get("FPBX_ARI_USER"),
		pbx.config.get("FPBX_ARI_PASSWORD")
	])
}).then(conf => {
	return ariclient.connect("http://localhost:"+conf[0], conf[1], conf[2])
}).then(ari => {
	ari.start('amazonlex')
	new Amazonlex(ari)
}).catch(err => {
	console.error(err)
	process.exit()
})

class Amazonlex {
	constructor(ari) {
		this.ari = ari
		this.ari.on('StasisStart', this.stasisStart.bind(this));
	}

	stasisStart(event, channelInstance) {
		channelInstance.answer(this.answer.bind(this, channelInstance))
	}

	answer(channelInstance) {
		console.log("Answered the Channel")
		this.play(channelInstance, 'sound:beep')
		.then(playback => {
			console.log("Finished Playing Audio")
			return this.recordAudio(channelInstance)
		})
		.then(response => {
			console.log(response)
			channelInstance.hangup()
		})
		.catch(e => {
			console.log(e)
		})
	}

	recordAudio(channelInstance) {
		return new Promise((resolve, reject) => {
			console.log(`Waiting for response from caller`)
			this.record(channelInstance)
			.then(recording => {
				const PATH = RECORDINGS+'/'+recording.name+'.wav'
				console.log(`Finished Recording Response from caller to ${PATH}`)
				return FS.readFileAsync(PATH)
			})
			.then(buffer => {
				console.log(`Sending Response from caller to be processed`)
				return this.sendBufferToLex(buffer, channelInstance.id)
			})
			.then(response => {
				console.log(`==> ${response.inputTranscript}`)
				console.log(`<== ${response.message}`)
				const file = `/var/lib/asterisk/sounds/tmp-${channelInstance.id}.sln16`;
				FS.writeFileAsync(file, response.audioStream)
				.then(n => {
					return this.play(channelInstance, `sound:tmp-${channelInstance.id}`)
				})
				.then(n => {
					return FS.unlinkAsync(file)
				})
				.then(n => {
					switch(response.dialogState) {
						case 'ElicitIntent':
						case 'ConfirmIntent':
						case 'ElicitSlot':
							return this.recordAudio(channelInstance)
						break;
						case 'Fulfilled':
						case 'ReadyForFulfillment':
							return Promise.resolve(response)
						break;
						case 'Failed':
							return Promise.reject(new Error('Failed State'))
						break;
						default:
							return Promise.reject(new Error(`Unknown dialogState of ${response.dialogState}`))
					}
				})
				.then(response => {
					resolve(response)
				})
				.catch(err => {
					reject(err)
				})
			})
			.catch(err => {
				reject(err)
			})
		})
	}

	sendBufferToLex(buffer,userid) {
		return new Promise((resolve, reject) => {
			var params = {
				botAlias: 'moviepedia',
				botName: 'moviePediaInfo',
				contentType: 'audio/lpcm; sample-rate=8000; sample-size-bits=16; channel-count=1; is-big-endian=false',
				inputStream: buffer,
				userId: userid,
				accept: 'audio/pcm'
			};
			lexruntime.postContent(params, function(err, data) {
				if (err) {
					reject(err)
				} else {
					resolve(data)
				}
			});
		})
	}

	play(channelInstance, file) {
		return new Promise((resolve, reject) => {
			let playback = this.ari.Playback();
			playback.once('PlaybackFinished',function (event, instance) {
				resolve(playback)
			});
			channelInstance.play({media: file}, playback)
			.catch(function (err) {
				reject(err);
			});
		})
	}

	record(channelInstance) {
		return new Promise((resolve, reject) => {
			channelInstance.record({
				beep: false,
				format: "wav",
				name: "testrecord-"+channelInstance.id+new Date().getTime(),
				maxSilenceSeconds: 2,
				ifExists: "overwrite",
				terminateOn: '#'
			})
			.then(liverecording => {
				liverecording.once("RecordingFinished", function(event, recording){
					resolve(recording)
				});
			})
			.catch(err => {
				console.error(err);
				this.play(channelInstance, 'sound:an-error-has-occurred')
				.then(err => {
					channelInstance.hangup()
				})
			});
		})
	}
}
