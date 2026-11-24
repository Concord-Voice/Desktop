import { createRequire } from 'node:module';
import path from 'node:path';
import { once } from 'node:events';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** A loopback-only fixture. No application auth or RoomManager assertion is made here. */
export async function createLocalSfu(mediaDirectory, { workerFactory } = {}) {
  const require = createRequire(path.join(mediaDirectory, 'package.json'));
  const mediasoup = require('mediasoup');
  const workerPath = await realpath(mediasoup.workerBin);
  const workerSha256 = createHash('sha256').update(await readFile(workerPath)).digest('hex');
  const expectedSha256 = process.env.MEDIA_PROBE_WORKER_SHA256;
  if (expectedSha256 !== undefined && (!/^[a-f0-9]{64}$/.test(expectedSha256) || expectedSha256 !== workerSha256)) {
    throw new Error('Native worker candidate SHA-256 mismatch');
  }
  const worker = await (workerFactory ?? mediasoup.createWorker)({ logLevel: 'error' });
  const closed = once(worker, 'subprocessclose');
  async function closeWorker() {
    let timer;
    try {
      worker.close();
      await Promise.race([closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native worker closure deadline')), 10_000);
      })]);
      if (!worker.subprocessClosed) throw new Error('Native worker exit unconfirmed');
    } finally { clearTimeout(timer); }
  }
  let router;
  try {
    router = await worker.createRouter({
    mediaCodecs: [
      { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
      { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
    ],
    });
  } catch (error) {
    await closeWorker();
    throw error;
  }
  const peers = new Map(['a', 'b'].map((id) => [id, {
    transports: new Map(), producers: new Map(), consumers: new Map(), consumerTransports: new Map(),
  }]));
  const owned = (map, id) => {
    const value = typeof id === 'string' && map.get(id);
    if (!value || value.closed) throw new Error('Unknown fixture resource');
    return value;
  };
  const rpc = async (body) => {
    if (!body || typeof body !== 'object') throw new Error('Invalid fixture request');
    const peer = peers.get(body.peer);
    if (!peer) throw new Error('Unknown fixture peer');
    switch (body.action) {
      case 'capabilities': return router.rtpCapabilities;
      case 'createTransport': {
        if (peer.transports.size >= 3) throw new Error('Fixture transport limit');
        if (!['send', 'audio', 'video'].includes(body.direction)) throw new Error('Invalid direction');
        const transport = await router.createWebRtcTransport({
          listenInfos: [{ protocol: 'udp', ip: '127.0.0.1' }],
          initialAvailableOutgoingBitrate: 2_000_000,
        });
        await transport.setMaxIncomingBitrate(5_000_000);
        peer.transports.set(transport.id, transport);
        return {
          id: transport.id, iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters,
        };
      }
      case 'connect': {
        await owned(peer.transports, body.transportId).connect({ dtlsParameters: body.dtlsParameters });
        return {};
      }
      case 'produce': {
        if (!['audio', 'video'].includes(body.kind) || peer.producers.size >= 2) {
          throw new Error('Invalid fixture producer');
        }
        const producer = await owned(peer.transports, body.transportId).produce({
          kind: body.kind, rtpParameters: body.rtpParameters,
        });
        peer.producers.set(producer.id, producer);
        return { id: producer.id };
      }
      case 'consume': {
        const other = peers.get(body.peer === 'a' ? 'b' : 'a');
        const producer = owned(other.producers, body.producerId);
        if (peer.consumers.size >= 2) throw new Error('Fixture consumer limit');
        const transport = owned(peer.transports, body.transportId);
        const consumer = await transport.consume({
          producerId: producer.id, rtpCapabilities: body.rtpCapabilities, paused: true,
        });
        peer.consumers.set(consumer.id, consumer);
        peer.consumerTransports.set(consumer.id, transport);
        // The probe publishes two active simulcast RIDs. Start high, then
        // switch to the low layer once this consumer's DTLS is connected.
        if (consumer.type === 'simulcast') await consumer.setPreferredLayers({ spatialLayer: 1, temporalLayer: 2 });
        return {
          id: consumer.id, producerId: producer.id, kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        };
      }
      case 'resume': {
        const consumer = owned(peer.consumers, body.consumerId);
        await consumer.resume();
        return {};
      }
      case 'requestKeyFrame': {
        const consumer = owned(peer.consumers, body.consumerId);
        if (consumer.kind !== 'video' || consumer.paused) throw new Error('Invalid keyframe request');
        const transport = owned(peer.consumerTransports, consumer.id);
        if (transport.dtlsState !== 'connected') return { ready: false };
        // A cold, packet-free simulcast consumer can stay without active layers
        // on macOS even after PLI. The post-DTLS preference change activates
        // the low stream; the probe later requires high-layer delivery too.
        if (consumer.type === 'simulcast') await consumer.setPreferredLayers({ spatialLayer: 0, temporalLayer: 0 });
        await consumer.requestKeyFrame();
        return { ready: true };
      }
      case 'promoteVideoLayer': {
        const video = [...peer.consumers.values()].filter((consumer) => consumer.kind === 'video' && consumer.type === 'simulcast');
        if (video.length !== 1) throw new Error('Fixture video consumer unavailable for layer promotion');
        const [consumer] = video;
        await consumer.setPreferredLayers({ spatialLayer: 1, temporalLayer: 2 });
        await consumer.requestKeyFrame();
        const deadline = Date.now() + 5_000;
        while (consumer.currentLayers?.spatialLayer !== 1) {
          if (Date.now() >= deadline) throw new Error('Fixture high video layer did not activate');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return { spatialLayer: consumer.currentLayers.spatialLayer, temporalLayer: consumer.currentLayers.temporalLayer };
      }
      case 'closeConsumer': {
        const consumer = owned(peer.consumers, body.consumerId);
        peer.consumers.delete(consumer.id); peer.consumerTransports.delete(consumer.id);
        consumer.close(); return {};
      }
      case 'closeProducer': {
        const producer = owned(peer.producers, body.producerId);
        peer.producers.delete(producer.id); producer.close(); return {};
      }
      case 'sfuDiagnose': {
        // Failure-only: bounded SFU-side counters, no ids, keys or raw reports.
        const trim = (entry) => ({ type: entry.type, kind: entry.kind, rid: entry.rid ?? null,
          packetCount: entry.packetCount ?? null, pliCount: entry.pliCount ?? null,
          firCount: entry.firCount ?? null, nackCount: entry.nackCount ?? null, score: entry.score ?? null });
        // One entity's failed stats read becomes an in-place marker; the rest of the report survives.
        const safe = async (read) => { try { return await read(); } catch (error) { return { statsError: error.message }; } };
        const trimAll = async (entity) => (await entity.getStats()).map(trim);
        const snapshot = async () => {
          const out = [];
          for (const [name, entry] of peers) {
            out.push({ peer: name,
              transports: await Promise.all([...entry.transports.values()].map((t) => safe(async () => {
                const [stat] = await t.getStats();
                return { ice: t.iceState, dtls: t.dtlsState, availableOutgoingBitrate: stat?.availableOutgoingBitrate ?? null,
                  sendBitrate: stat?.sendBitrate ?? null };
              }))),
              producers: await Promise.all([...entry.producers.values()].map((p) => safe(async () => ({
                kind: p.kind, type: p.type, paused: p.paused, score: p.score, stats: await trimAll(p) })))),
              consumers: await Promise.all([...entry.consumers.values()].map((c) => safe(async () => ({
                kind: c.kind, type: c.type, paused: c.paused, producerPaused: c.producerPaused,
                score: c.score, currentLayers: c.currentLayers ?? null, preferredLayers: c.preferredLayers ?? null,
                stats: await trimAll(c) })))) });
          }
          return out;
        };
        const before = await snapshot();
        if (body.probeLowestLayer !== true) return before;
        // This intervention happens only after the runtime probe has failed.
        // It distinguishes layer selection from missing sender keyframes without
        // changing any passing-path assertion or allowing recovery to pass CI.
        const intervention = [];
        for (const [name, entry] of peers) {
          for (const consumer of entry.consumers.values()) {
            if (consumer.kind !== 'video' || consumer.type !== 'simulcast') continue;
            try {
              await consumer.setPreferredLayers({ spatialLayer: 0, temporalLayer: 0 });
              await consumer.requestKeyFrame();
              intervention.push({ peer: name, result: 'requested' });
            } catch {
              intervention.push({ peer: name, result: 'failed' });
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return { before, intervention, after: await snapshot() };
      }
      default: throw new Error('Unknown fixture action');
    }
  };
  return {
    version: mediasoup.version,
    nativeWorker: {
      path: workerPath, sha256: workerSha256,
      selection: process.env.MEDIASOUP_WORKER_BIN ? 'MEDIASOUP_WORKER_BIN override' : 'package default',
      candidateDigestBinding: expectedSha256 ? 'MATCHED supplied candidate digest' : 'NOT VERIFIED',
    },
    rpc,
    close: closeWorker,
  };
}
