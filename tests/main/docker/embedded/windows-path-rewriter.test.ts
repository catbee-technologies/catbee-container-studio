import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { expect, it } from 'vitest';
import {
  DockerRequestRewriter,
  translateContainerCreateBody,
  translateVolumeCreateBody
} from '../../../../src/main/docker/embedded/windows-path-rewriter';

function rewrite(chunks: Buffer[]): Promise<Buffer> {
  return pipeline(Readable.from(chunks), new DockerRequestRewriter(), async source => {
    const output: Buffer[] = [];
    for await (const chunk of source) output.push(chunk);
    return Buffer.concat(output);
  });
}

it('rewrites only Windows bind sources in container create requests', () => {
  const body = {
    HostConfig: {
      Binds: [String.raw`C:\Users\me\src:/workspace:ro`, 'c:/cache:ro', '/var/tmp:/scratch'],
      Mounts: [
        { Type: 'bind', Source: 'D:/shared', Target: '/share' },
        { Type: 'volume', Source: 'cache', Target: '/cache' }
      ]
    }
  };

  expect(translateContainerCreateBody(body)).toBe(true);
  expect(body.HostConfig.Binds).toEqual(['/mnt/c/Users/me/src:/workspace:ro', 'c:/cache:ro', '/var/tmp:/scratch']);
  expect(body.HostConfig.Mounts.map(mount => mount.Source)).toEqual(['/mnt/d/shared', 'cache']);
  expect(translateContainerCreateBody(body)).toBe(false);
});

it('rewrites local volume devices only when the bind option is present', () => {
  const local = { DriverOpts: { o: 'bind,ro', device: 'D:/shared' } };
  const network = { DriverOpts: { o: 'addr=host,ro', device: 'D:/remote' } };
  expect(translateVolumeCreateBody(local)).toBe(true);
  expect(local.DriverOpts.device).toBe('/mnt/d/shared');
  expect(translateVolumeCreateBody(network)).toBe(false);
  expect(network.DriverOpts.device).toBe('D:/remote');
});

it.each(['content-length', 'chunked'])(
  'rewrites a fragmented %s request and preserves the following request',
  async framing => {
    const json = JSON.stringify({ HostConfig: { Binds: ['D:/Café:/workspace:ro'] } });
    const body = Buffer.from(json);
    const next = 'GET /_ping HTTP/1.1\r\nHost: docker\r\n\r\n';
    const head = 'POST /v1.47/containers/create HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n';
    const payload =
      framing === 'chunked'
        ? Buffer.concat([
            Buffer.from(head + 'Transfer-Encoding: chunked\r\n\r\n' + body.length.toString(16) + '\r\n'),
            body,
            Buffer.from('\r\n0\r\n\r\n' + next)
          ])
        : Buffer.concat([Buffer.from(head + 'Content-Length: ' + body.length + '\r\n\r\n'), body, Buffer.from(next)]);
    const fragments: Buffer[] = [];
    for (let offset = 0; offset < payload.length; offset += 7) {
      fragments.push(payload.subarray(offset, offset + 7));
    }

    const output = await rewrite(fragments);
    const boundary = output.indexOf('\r\n\r\n');
    expect(boundary).toBeGreaterThan(0);
    const rewrittenHead = output.subarray(0, boundary).toString('ascii');
    const rewrittenBody = output.subarray(boundary + 4, -Buffer.byteLength(next));
    expect(rewrittenHead).toMatch(new RegExp('^content-length: ' + rewrittenBody.length + '$', 'im'));
    expect(rewrittenHead.toLowerCase()).not.toContain('transfer-encoding');
    expect(JSON.parse(rewrittenBody.toString('utf8'))).toEqual({
      HostConfig: { Binds: ['/mnt/d/Café:/workspace:ro'] }
    });
    expect(output.subarray(-Buffer.byteLength(next)).toString('ascii')).toBe(next);
  }
);

it('forwards upgraded data byte-for-byte, even when it resembles a Docker request', async () => {
  const upgrade = Buffer.from('GET /session HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n');
  const data = Buffer.from(
    'POST /containers/create HTTP/1.1\r\nContent-Length: 44\r\n\r\n' + '{"HostConfig":{"Binds":["C:/src:/workspace"]}}'
  );
  const binary = Buffer.from([0, 255, 10, 13]);
  await expect(rewrite([upgrade, data, binary])).resolves.toEqual(Buffer.concat([upgrade, data, binary]));
});
