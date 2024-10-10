/* eslint-disable max-len */

'use strict';

const generateQueueNames = require('./helper/generate-names');

const {
	consumerDefaultsValue,
	mainQueueDefaultsValue,
	delayQueueDefaultsValue,
	dlqConsumerDefaultsValue,
	dlqQueueDefaultsValue,
	baseArn,
	baseUrl
} = require('./helper/default');

const { defaultTags } = require('../utils/default-tags');
const fixFifoName = require('./helper/fix-fifo-name');
const generateArns = require('./helper/generate-arns');

module.exports = class SQSHelper {

	static get sqsPermissions() {
		return ['iamStatement', {
			action: [
				'sqs:SendMessage',
				'sqs:DeleteMessage',
				'sqs:ReceiveMessage',
				'sqs:GetQueueAttributes'
			],
			// eslint-disable-next-line no-template-curly-in-string
			resource: `${baseArn}:*`
		}];
	}

	static buildHooks(configs = {}) {

		this.validateConfigs(configs);

		this.setConfigsWithDefaults(configs);

		const delayHooks = [];

		if(this.useDelayQueue) {

			// is used this.delayConsumerProperties cause must have a consumer (the own consumer or the main consumer)
			// this.delayConsumerProperties has default mainConsumer configs
			if(this.shouldAddConsumer(this.delayConsumerProperties))
				delayHooks.push(this.buildConsumerFunction(this.delayConsumerProperties, { delayConsumer: true }));

			delayHooks.push(this.buildQueueResource(this.delayQueueProperties, { delayQueue: true }));
		}

		return [

			...this.getSQSUrlEnvVars(),

			this.buildConsumerFunction(this.consumerProperties, { mainConsumer: true }),

			this.buildQueueResource(this.mainQueueProperties, { mainQueue: true }),

			...delayHooks,

			this.buildQueueResource(this.dlqQueueProperties, { dlq: true }),

			...this.shouldAddConsumer(configs.dlqConsumerProperties)
				? [this.buildConsumerFunction(this.dlqConsumerProperties, { dlqConsumer: true })]
				: []
		];
	}

	static validateConfigs(configs) {

		if(!configs.name?.length)
			throw new Error('Missing or empty name hook configuration in SQS helper');

		[
			['Main Consumer', configs.consumerProperties],
			['Main Queue', configs.mainQueueProperties],
			['Delay Consumer', configs.delayConsumerProperties],
			['Delay Queue', configs.delayQueueProperties],
			['DLQ Consumer', configs.dlqConsumerProperties],
			['DLQ Queue', configs.dlqQueueProperties]
		].forEach(([type, properties]) => {
			if(properties && (typeof properties !== 'object' || Array.isArray(properties)))
				throw new Error(`${type} Properties must be an Object with configuration in SQS helper`);
		});
	}

	static setConfigsWithDefaults(userConfigs) {

		this.consumerProperties = { ...consumerDefaultsValue, ...userConfigs.consumerProperties };
		this.mainQueueProperties = { ...mainQueueDefaultsValue, ...userConfigs.mainQueueProperties };

		// delay queue and consumer uses main config by default
		this.delayConsumerProperties = { ...consumerDefaultsValue, ...userConfigs.delayConsumerProperties };
		this.delayQueueProperties = { ...delayQueueDefaultsValue, ...userConfigs.delayQueueProperties };

		this.dlqConsumerProperties = { ...dlqConsumerDefaultsValue, ...userConfigs.dlqConsumerProperties };
		this.dlqQueueProperties = { ...dlqQueueDefaultsValue, ...userConfigs.dlqQueueProperties };

		this.fifoQueue = !!userConfigs.mainQueueProperties?.fifoQueue;
		this.useDelayQueue = !!userConfigs.delayQueueProperties;

		this.names = generateQueueNames(userConfigs.name);

		this.arns = generateArns(this.names, this.fifoQueue);
	}

	static shouldAddConsumer(consumerProperties) {
		return consumerProperties
			&& Object.keys(consumerProperties).length
			&& !consumerProperties.useMainHandler;
	}

	static getSQSUrlEnvVars() {

		const shouldGenerateEnvVars = this.mainQueueProperties.generateEnvVars ||
			this.dlqQueueProperties.generateEnvVars ||
			this.delayQueueProperties.generateEnvVars;

		if(!shouldGenerateEnvVars)
			return [];

		return [
			['envVars', {
				...this.mainQueueProperties.generateEnvVars && { [`${this.names.envVarName}_SQS_QUEUE_URL`]: `${baseUrl}\${self:custom.serviceName}${fixFifoName(this.names.mainQueue, this.fifoQueue)}` },
				...this.dlqQueueProperties.generateEnvVars && { [`${this.names.envVarName}_DLQ_QUEUE_URL`]: `${baseUrl}\${self:custom.serviceName}${fixFifoName(this.names.dlq, this.fifoQueue)}` },

				...this.delayQueueProperties.generateEnvVars && {
					[`${this.names.envVarName}_DELAY_QUEUE_URL`]: `${baseUrl}\${self:custom.serviceName}${fixFifoName(this.names.delayQueue, this.fifoQueue)}`
				}
			}]
		];
	}

	static buildConsumerFunction({
		timeout,
		handler,
		description,
		maximumBatchingWindow,
		batchSize,
		prefixPath,
		functionProperties,
		rawProperties,
		eventProperties
	}, {
		mainConsumer,
		delayConsumer
	}) {

		let { filename, titleName: functionName } = this.names;

		let queueArn;
		let dependsOn;

		if(mainConsumer) {
			queueArn = this.arns.mainQueue;
			dependsOn = this.names.mainQueue;
		} else if(delayConsumer) {
			queueArn = this.arns.delayQueue;
			dependsOn = this.names.delayQueue;
			functionName = `${functionName}Delay`;
			filename = `${filename}-delay`;
		} else {
			// dlq consumer
			queueArn = this.arns.dlq;
			dependsOn = this.names.dlq;
			functionName = `${functionName}DLQ`;
			filename = `${filename}-dlq`;
		}

		if(prefixPath)
			filename = `${prefixPath}/${filename}`;

		return ['function', {
			functionName: `${functionName}QueueConsumer`,
			handler: handler || `src/sqs-consumer/${filename}-consumer.handler`,
			description: description || `${functionName} SQS Queue Consumer`,
			timeout,
			rawProperties: {
				dependsOn: [dependsOn],
				...rawProperties
			},
			events: [
				this.createEventSource(queueArn, { batchSize, maximumBatchingWindow, eventProperties }),
				...mainConsumer && this.delayConsumerProperties?.useMainHandler ? [this.createEventSource(this.arns.delayQueue, this.delayConsumerProperties)] : [],
				...mainConsumer && this.dlqConsumerProperties?.useMainHandler ? [this.createEventSource(this.arns.dlq, this.dlqConsumerProperties)] : []
			],
			...functionProperties
		}];
	}

	static createEventSource(arn, {
		batchSize,
		maximumBatchingWindow,
		eventProperties
	}) {
		return {
			sqs: {
				arn,
				functionResponseType: 'ReportBatchItemFailures',
				...batchSize && { batchSize },
				...maximumBatchingWindow && { maximumBatchingWindow },
				...eventProperties
			}
		};
	}

	static buildQueueResource({
		maxReceiveCount,
		receiveMessageWaitTimeSeconds,
		visibilityTimeout,
		messageRetentionPeriod,
		delaySeconds,
		fifoQueue,
		fifoThroughputLimit,
		contentBasedDeduplication,
		deduplicationScope,
		addTags,
		generateEnvVars,
		...extraProperties
	}, {
		mainQueue,
		dlq,
		delayQueue
	}) {

		let name;
		let deadLetterTargetArn;
		let dependsOn;

		if(mainQueue) {
			name = this.names.mainQueue;
			deadLetterTargetArn = this.useDelayQueue ? this.arns.delayQueue : this.arns.dlq;
			dependsOn = this.useDelayQueue ? this.names.delayQueue : this.names.dlq;
		} else if(delayQueue) {
			name = this.names.delayQueue;
			deadLetterTargetArn = this.arns.dlq;
			dependsOn = this.names.dlq;
		} else {
			// dlq
			name = this.names.dlq;
		}

		return ['resource', {
			name,
			resource: {
				Type: 'AWS::SQS::Queue',
				Properties: {
					QueueName: `\${self:custom.serviceName}${fixFifoName(name, this.fifoQueue)}`,
					ReceiveMessageWaitTimeSeconds: receiveMessageWaitTimeSeconds,
					VisibilityTimeout: visibilityTimeout,
					// eslint-disable-next-line max-len
					...deadLetterTargetArn && {
						RedrivePolicy: JSON.stringify({ maxReceiveCount, deadLetterTargetArn })
					},
					...messageRetentionPeriod && { MessageRetentionPeriod: messageRetentionPeriod },
					...delaySeconds && { DelaySeconds: delaySeconds },
					...this.fifoQueue && { FifoQueue: true },
					...this.fifoQueue && fifoThroughputLimit && { FifoThroughputLimit: fifoThroughputLimit },
					...this.fifoQueue && deduplicationScope && { DeduplicationScope: deduplicationScope },
					...this.fifoQueue && contentBasedDeduplication && { ContentBasedDeduplication: true },
					Tags: [
						...defaultTags,
						{ Key: 'SQSConstruct', Value: this.names.titleName },
						...dlq ? [{ Key: 'IsDLQ', Value: 'true' }] : [],
						...delayQueue ? [{ Key: 'DelayQueue', Value: 'true' }] : [],
						...addTags || []
					],
					...extraProperties
				},
				...dependsOn && { DependsOn: [dependsOn] }
			}
		}];
	}
};
