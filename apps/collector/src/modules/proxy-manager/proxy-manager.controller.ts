import { FastifyInstance } from 'fastify';
import { ProxyManagerService } from './proxy-manager.service.js';

export async function proxyManagerController(fastify: FastifyInstance) {
  const service = new ProxyManagerService(fastify.db);

  fastify.get('/status', async () => {
    return service.getStatus();
  });

  fastify.post('/start', async () => {
    await service.start();
    return { success: true };
  });

  fastify.post('/stop', async () => {
    await service.stop();
    return { success: true };
  });

  fastify.post('/restart', async () => {
    await service.restart();
    return { success: true };
  });

  fastify.post('/config', async (request) => {
    const { subscriptionUrl, name } = request.body as { subscriptionUrl: string, name?: string };
    if (!subscriptionUrl) throw new Error('Subscription URL is required');
    await service.updateConfig(subscriptionUrl, name);
    return { success: true };
  });

  fastify.get('/profiles', async () => {
    return { profiles: service.listProfiles() };
  });

  fastify.post('/profiles/switch', async (request) => {
    const { name } = request.body as { name: string };
    if (!name) throw new Error('Profile name is required');
    await service.switchProfile(name);
    return { success: true };
  });

  fastify.delete('/profiles/:name', async (request) => {
    const { name } = request.params as { name: string };
    if (!name) throw new Error('Profile name is required');
    await service.deleteProfile(name);
    return { success: true };
  });

  fastify.get('/logs', async (request) => {
    const query = request.query as { lines?: string };
    const lines = parseInt(query.lines || '100', 10);
    return { logs: service.getLogs(lines) };
  });

  fastify.post('/tun', async (request) => {
    const { enable } = request.body as { enable: boolean };
    await service.setTunMode(enable);
    return { success: true };
  });
}
