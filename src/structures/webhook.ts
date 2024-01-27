import { RESTPostAPIWebhookWithTokenJSONBody } from 'discord-api-types/v10';
import { createLogger } from '~/structures/logger';
import { splitMessage } from '~/utilities';
import FormData from 'form-data';
import { inspect } from 'util';
import config from '~/config';

class Webhook {
	logger = createLogger('Webhook');

	constructor(public url: string) { }

	async send(message: RESTPostAPIWebhookWithTokenJSONBody) {
		if (message.content.length > 2000) {
			const chunks = splitMessage(message.content);

			for (const chunk of chunks) {
				await this.send({ ...message, content: chunk });
			}

			return;
		}

		try {
			const form = new FormData();

			form.append('payload_json', JSON.stringify(message));

			return await new Promise((resolve, reject) => {
				form.submit(this.url, (err, res) => {
					if (err) {
						(err);
						throw err;
					}

					res.on('data', data => {
						if (data) {
							const res = JSON.parse(data);
							this.logger.debug('Webhook response:\n');
							this.logger.debug(res);
						}
					});

					res.on('end', resolve);
					res.on('error', reject);

					this.logger.debug(`Forwarding payload to webhook.`);
					this.logger.debug(inspect({ url: this.url, message }));
					res.resume();
				});
			});
		} catch (error) {
			this.logger.error('Failed to send to webhook!', error, this.url, message);
		}
	};
}

export default new Webhook(config.webhook);