const https = require('https');

class JulesClient {
  constructor() {
    this.apiKey = process.env.JULES_API_KEY || '';
    this.baseUrl = 'jules.googleapis.com';
    if (!this.apiKey) {
      console.warn('Warning: JULES_API_KEY environment variable is not set.');
    }
  }

  _request(options, postData = null) {
    return new Promise((resolve, reject) => {
      const reqOptions = {
        hostname: this.baseUrl,
        port: 443,
        path: `/v1alpha${options.path}`,
        method: options.method || 'GET',
        headers: {
          'X-Goog-Api-Key': this.apiKey,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      };

      const req = https.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            if (data.length > 0) {
              const parsed = JSON.parse(data);
              if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve(parsed);
              } else {
                reject(new Error(`API Error ${res.statusCode}: ${JSON.stringify(parsed)}`));
              }
            } else {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                 resolve({});
              } else {
                 reject(new Error(`API Error ${res.statusCode}`));
              }
            }
          } catch (e) {
            reject(new Error(`Failed to parse response: ${e.message}`));
          }
        });
      });

      req.on('error', (e) => reject(e));

      if (postData) {
        req.write(JSON.stringify(postData));
      }
      req.end();
    });
  }

  async listSources() {
    return this._request({ path: '/sources' });
  }

  async createSession(prompt, repo) {
    return this._request(
      { path: '/sessions', method: 'POST' },
      {
        prompt,
        sourceContext: { repo },
        automationMode: 'AUTOMATED', // You might want this to be configurable later
      }
    );
  }

  async getSession(sessionId) {
    return this._request({ path: `/sessions/${sessionId}` });
  }

  async pollSession(sessionId, intervalMs = 10000) {
    const terminalStates = ['COMPLETED', 'FAILED', 'CANCELED'];
    while (true) {
      const session = await this.getSession(sessionId);
      if (session.status && terminalStates.includes(session.status.state)) {
        return session;
      }
      // Wait for intervalMs
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  async listActivities(sessionId) {
    return this._request({ path: `/sessions/${sessionId}/activities` });
  }

  async approvePlan(sessionId) {
    return this._request(
      { path: `/sessions/${sessionId}:approvePlan`, method: 'POST' },
      {} // usually empty body for this type of action
    );
  }
}

module.exports = { JulesClient };
