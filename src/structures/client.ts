import { Channel, DMChannel, Client as DiscordJSClient, Guild, Message, PartialGroupDMChannel, TextChannel } from 'discord.js-selfbot-v13';
import { RESTPostAPIWebhookWithTokenJSONBody } from 'discord-api-types/v9';
import { createLogger } from '~/structures/logger';
import { sleep, strip } from '~/utilities';
import Webhook from '~/structures/webhook';
import config from '~/config';

class Client extends DiscordJSClient {
	logger = createLogger('Client');
	pruning = new Set();

	constructor() {
		super({
			checkUpdate: false,
			restTimeOffset: 0
		});

		this.on('ready', this.onReady.bind(this));
		this.on('messageCreate', this.onMessage.bind(this));
	}

	start() {
		this.logger.info(`Logging in with ${strip(config.token)}...`);
		this.login(config.token);

		if (!config.feedback) {
			this.logger.warn('Feedback mode was not provided, assuming you do not want to receive feedback alerts.');
		}

		if (!['alt', 'webhook'].includes(config.feedback)) {
			this.logger.warn(`Invalid feedback mode: ${config.feedback}. Available feedback modes: "alt", "webhook".`);
		}

		if (config.feedback === 'alt' && !config.altToken) {
			this.logger.warn('Feedback mode is set to alt but no alt token was provided, you will not receive feedback alerts.');
		}

		if (config.feedback === 'webhook' && !config.webhook) {
			this.logger.warn('Feedback mode is set to webhook but no webhook was provided, you will not receive feedback alerts.');
		}
	}

	onReady() {
		this.logger.success(`Logged in as ${this.user.tag}`);
	}

	async onMessage(msg: Message) {
		if (msg.author.id !== this.user.id || !msg.content.startsWith(config.prefix)) return;

		await msg.delete();

		const args = msg.content.split(' ');
		const command = args.shift().replace(config.prefix, '');

		const _amount = args.shift();
		const id = args.shift();
		const isServer = args.shift();

		if (command !== 'clear') {
			return this.sendFeedback({ content: `Invalid command: ${command}. This command does not exist.` });
		}

		if (!_amount || (['stop', 'all'].includes(_amount) && Number.isNaN(_amount))) {
			return this.sendFeedback({ content: 'Second argument "amount" must be either "all" or a number.' });
		}

		const amount = ['stop', 'all'].includes(_amount) ? _amount : Number.parseInt(_amount);
		const channel = isServer === 'server' ? this.guilds.cache.get(id) : (!id ? msg.channel : this.channels.cache.get(id));
		if (!channel) return this.sendFeedback({ content: 'Invalid channel/server provided.' });

		if (amount === 'stop') {
			this.pruning.delete(channel.id);
			this.logger.info(`Stopped prune process for ${channel.id}.`);
			return this.sendFeedback({ content: `Stopped pruning proccess for **${this.getName(channel as any)}**.` });
		}

		if (this.pruning.has(channel.id)) {
			return this.sendFeedback({ content: `This channel/server is already being pruned. To stop, please use \`${config.prefix}clear stop ${msg.channel.id}\` ` });
		}

		this.pruning.add(channel.id);

		const result = {
			amount: 0,
			offset: 0
		};

		this.sendFeedback({ content: `Started pruning **${this.getName(channel as any)}** (Amount: ${amount}, Is server: ${isServer ?? false})` });

		while (this.pruning.has(channel.id) && (amount === 'all' || amount as number > result.amount)) {
			const payload = await this.getMessages(channel as Guild | Channel, result.offset, isServer === 'server' ? true : false, isServer === 'server' ? true : (channel as TextChannel).guild?.id);



			// if (payload.messages.length <= 0 && payload.skipped === 0) break;
			if (payload.offset !== result.offset) result.offset = payload.offset;

			if (payload.messages.length) {
				if (amount !== 'all' && payload.messages.length > amount) {
					payload.messages = payload.messages.slice(0, amount);
				}

				for (const message of payload.messages) {
					if (!this.pruning.has(channel.id)) break;

					result.amount += await this.delete(message, message.channel_id);
					await sleep(config.delay);
				}
			} else if (payload.total === 0) {
				this.logger.info(`No more messages exist in ${this.getName(channel as Channel)}. We are done here.`);
				break;
			} else {
				this.logger.warn(`API returned empty page. Will retry search in ${config.searchDelay}ms.`);
			}

			await sleep(config.searchDelay);
		}

		this.pruning.delete(channel.id);

		if (result.amount > 0) {
			this.logger.success(`Cleared ${result.amount} messages in ${this.getName(channel as any)} (Is Server: ${isServer === 'server'}, Requested Amount: ${amount})`);
			this.sendFeedback({ content: `Cleared **${result.amount}** messages in **${this.getName(channel as any)}** (Is Server: ${isServer === 'server'}, Requested Amount: ${amount})` });
		} else {
			this.logger.success(`No messages were cleared in ${this.getName(channel as any)} (Is Server: ${isServer === 'server'}, Requested Amount: ${amount})`);
			this.sendFeedback({ content: `No messages were cleared in **${this.getName(channel as any)}** (Is Server: ${isServer === 'server'}, Requested Amount: ${amount})` });
		}
	}

	async delete(message: Message, channel: string) {
		try {
			const request = await fetch(`https://discord.com/api/v${this.options.http.version}/channels/${channel}/messages/${message.id}`, {
				method: 'DELETE',
				headers: {
					'Authorization': config.token,
					'X-Super-Properties': btoa(JSON.stringify(config.properties)),
					'User-Agent': config.properties.browser_user_agent
				}
			});

			const json = await request.json().catch(() => { return {}; });

			switch (request.status) {
				case 204:
					return 1;
				case 404:
					this.logger.error(`Couldn't delete message ${message} (It does not exist, it is most likely already deleted.)`);
				case 429:
					this.logger.warn(`Ratelimited while deleting message ${message}. Waiting ${json.retry_after * 1000}ms`);
					await sleep(json.retry_after * 1000);
					return this.delete(message, channel);
				default:
					this.logger.error(`Got unexpected status code while deleting message ${message}: ${request.status} (Response: ${JSON.stringify(json, null, 2)})`);
			}

			return 0;
		} catch (error) {
			this.logger.error(`Failed to delete message ${message} in channel ${channel}:`, error);
			this.sendFeedback({ content: `Failed to search for messages in channel ${channel}. Check console for more details.` });

			return 0;
		}
	}

	async getMessages(channel: Channel | Guild, offset: number, wholeGuild = false, inGuild: boolean | string = false) {
		try {
			const out = [];
			const url = new URL(`https://discord.com/api/v${this.options.http.version}/${(inGuild || wholeGuild) ? 'guilds' : 'channels'}/${wholeGuild ? channel.id : (inGuild || channel.id)}/messages/search`);

			url.searchParams.append('author_id', this.user.id);
			if (offset > 0) url.searchParams.append('offset', offset.toString());
			if (inGuild && !wholeGuild) url.searchParams.append('channel_id', channel.id);

			this.logger.info(`Fetching messages for ${this.getName(channel)}. Is Guild Channel: ${inGuild}, Clear Whole Guild: ${wholeGuild}, Offset: ${offset}`);
			const request = await fetch(url, {
				headers: {
					'Authorization': config.token,
					'User-Agent': config.properties.browser_user_agent,
					'X-User-Properties': btoa(JSON.stringify(config.properties))
				}
			});

			const json = await request.json();

			switch (request.status) {
				case 200:
				case 203:
					break;

				case 429: {
					if (!json.retry_after) return this.getMessages(channel, offset, wholeGuild, inGuild);
					this.logger.error(`Ratelimited while fetching messages for ${this.getName(channel)}. Waiting ${json.retry_after * 1000}ms`);
					await sleep(json.retry_after * 1000);
					return this.getMessages(channel, offset, wholeGuild, inGuild);
				} break;

				default: {
					this.logger.error(`Got unexpected status code while searching in ${this.getName(channel)}: ${request.status} (Response: ${JSON.stringify(json, null, 2)})`);
				} break;
			}

			if (json.message && json.message.startsWith('Index')) {
				this.logger.info(`${this.getName(channel)} is still indexing. Will retry in ${json.retry_after * 1000}ms.`);
				await sleep(json.retry_after * 1000);
				return this.getMessages(channel, offset, wholeGuild, inGuild);
			}

			const { messages } = json;
			if (!messages?.length) {
				return {
					messages: [],
					offset,
					total: json.total_results - offset,
					skipped: 0
				};
			}

			let skipped = 0;
			for (const bulk of messages) {
				const hits = bulk.filter(message => message.hit == true);
				const filtered = hits.filter(message => [0, 6, 19].includes(message.type));

				out.push(...filtered);
				skipped += hits.filter(message => !out.find(m => m.id === message.id))?.length ?? 0;
			}

			this.logger.info(`Fetched ${out.length} pruneable messages.`);

			return {
				messages: out.sort((a, b) => b.id - a.id),
				offset: skipped + offset,
				total: json.total_results - offset,
				skipped: skipped
			};
		} catch (error) {
			this.logger.error(`Failed to search for messages in channel ${this.getName(channel)}:`, error);
			this.sendFeedback({ content: `Failed to search for messages in channel ${this.getName(channel)}. Check console for more details.` });

			return {
				messages: [],
				offset: offset,
				total: 0,
				skipped: 0
			};
		}
	}

	async sendFeedback(payload: RESTPostAPIWebhookWithTokenJSONBody) {
		switch (config.feedback) {
			case 'alt': {
				if (!config.altChannelId || !config.altToken) return;

				try {
					const res = await fetch(`https://discord.com/api/v9/channels/${config.altChannelId}/messages`, {
						body: JSON.stringify(payload),
						method: 'POST',
						headers: {
							'Authorization': config.altToken,
							'Content-Type': 'application/json',
							'X-Super-Properties': btoa(JSON.stringify(config.properties))
						}
					});

					const json = await res.json();

					if (res.status !== 200) {
						if (res.status === 429) {
							this.logger.warn(`Ratelimited while sending feedback. Waiting ${json.retry_after * 1000}ms then trying again.`);
							await sleep(json.retry_after * 1000);
							return this.sendFeedback(payload);
						}

						return this.logger.warn('Got unexpected response when sending feedback from alt token:', res.status, json);
					}
				} catch (error) {
					this.logger.error('Failed to send message from alt:', error);
				}
			} break;

			case 'webhook': {
				if (!config.webhook) return;

				Webhook.send(payload);
			} break;
		}
	}

	getName(instance: Guild | Channel) {
		if ((instance as Guild).mfaLevel) {
			return 'Server ' + (instance as Guild).name + ` (${instance.id})`;
		}

		if ((instance as Channel).type === 'DM') {
			const recipient = (instance as DMChannel).recipient;
			return 'DM with ' + (recipient.displayName ?? recipient.username) + ` (${instance.id})`;
		}

		if ((instance as Channel).type === 'GUILD_TEXT') {
			return '#' + (instance as Guild).name! + ` (${instance.id})`;
		}

		if ((instance as Channel).type === 'GROUP_DM') {
			const channel = (instance as PartialGroupDMChannel);
			const recipients = channel.recipients;

			return 'Group DM ' + (channel.name ?? 'with ' + recipients.map(r => r.displayName ?? r.username).join(', ')) + ` (${instance.id})`;
		}

		return ((instance as any)?.name ?? 'Unknown') + ` (${instance.id})`;
	}
}

export default Client;