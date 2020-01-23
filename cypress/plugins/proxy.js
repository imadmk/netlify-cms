const fs = require('fs-extra');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { updateConfig } = require('../utils/config');
const { merge } = require('lodash');
const { getGitClient } = require('./common');

const initRepo = async dir => {
  await fs.remove(dir);
  await fs.mkdirp(dir);
  const git = getGitClient(dir);
  await git.init();
  await git.addConfig('user.email', 'cms-cypress-test@netlify.com');
  await git.addConfig('user.name', 'cms-cypress-test');

  const readme = 'README.md';
  await fs.writeFile(path.join(dir, readme), '');
  await git.add(readme);
  await git.commit('initial commit', readme, { '--no-verify': true, '--no-gpg-sign': true });
};

const getFreePort = async () => {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, () => {
      const port = server.address().port;
      server.once('close', () => {
        resolve(port);
      });
      server.close();
    });
  });
};

const startServer = async repoDir => {
  const tsNode = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'ts-node');
  const serverDir = path.join(__dirname, '..', '..', 'packages', 'netlify-cms-proxy-server');
  const distIndex = path.join(serverDir, 'dist', 'index.js');
  const tsIndex = path.join(serverDir, 'src', 'index.ts');

  const port = await getFreePort();
  const env = { ...process.env, GIT_REPO_DIRECTORY: path.resolve(repoDir), PORT: port };
  let server;
  if (await fs.pathExists(distIndex)) {
    server = spawn('node', [distIndex], { env, cwd: serverDir });
  } else {
    server = spawn(tsNode, ['--files', tsIndex], { env, cwd: serverDir });
  }

  return new Promise((resolve, reject) => {
    let timeout = setTimeout(() => {
      server.kill();
      reject('timed out waiting for proxy server');
    }, 20 * 1000);

    server.stdout.on('data', data => {
      const message = data.toString().trim();
      console.log(`server:stdout: ${message}`);
      if (message.startsWith('Netlify CMS Proxy Server listening on port')) {
        clearTimeout(timeout);
        resolve({ server, port: env.PORT });
      }
    });

    server.stderr.on('data', data => {
      console.error(`server:stderr: ${data.toString().trim()}`);
      reject(data.toString());
    });
  });
};

let serverProcess;

async function setupProxy(options) {
  const postfix = Math.random()
    .toString(32)
    .substring(2);

  const testRepoName = `proxy-test-repo-${Date.now()}-${postfix}`;
  const tempDir = path.join('.temp', testRepoName);

  await updateConfig(config => {
    merge(config, options);
  });

  return { tempDir };
}

async function teardownProxy(taskData) {
  if (serverProcess) {
    serverProcess.kill();
  }
  await fs.remove(taskData.tempDir);

  return null;
}

async function setupProxyTest(taskData) {
  await initRepo(taskData.tempDir);
  const { server, port } = await startServer(taskData.tempDir);

  await updateConfig(config => {
    merge(config, {
      backend: {
        proxy_url: `http://localhost:${port}/api/v1`,
      },
    });
  });

  serverProcess = server;
  return null;
}

async function teardownProxyTest(taskData) {
  if (serverProcess) {
    serverProcess.kill();
  }
  await fs.remove(taskData.tempDir);
  return null;
}

module.exports = {
  setupProxy,
  teardownProxy,
  setupProxyTest,
  teardownProxyTest,
};
