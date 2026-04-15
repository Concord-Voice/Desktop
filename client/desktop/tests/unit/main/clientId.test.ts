import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => {
  const execFile = vi.fn();
  return { execFile, default: { execFile } };
});

vi.mock('node:fs/promises', () => {
  const readFile = vi.fn();
  return { readFile, default: { readFile } };
});

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  isSentinelValue,
  hashInputs,
  makeFallbackId,
  computeClientId,
  getDiskUUIDMacOS,
  getMotherboardSerialMacOS,
  getDiskUUIDLinux,
  getMotherboardSerialLinux,
  getDiskUUIDWindows,
  getMotherboardSerialWindows,
  getPlatformRetrievers,
} from '../../../src/main/clientId';

describe('isSentinelValue', () => {
  it('rejects all-zeros string', () => {
    expect(isSentinelValue('00000000')).toBe(true);
    expect(isSentinelValue('000000000000')).toBe(true);
  });
  it('rejects VMware-prefixed strings', () => {
    expect(isSentinelValue('VMware-56 4d 8a')).toBe(true);
  });
  it('rejects QEMU-prefixed strings', () => {
    expect(isSentinelValue('QEMU-XYZ')).toBe(true);
  });
  it('rejects empty string', () => {
    expect(isSentinelValue('')).toBe(true);
  });
  it('rejects strings shorter than 6 chars', () => {
    expect(isSentinelValue('abc')).toBe(true);
  });
  it('rejects strings longer than 256 chars', () => {
    expect(isSentinelValue('x'.repeat(257))).toBe(true);
  });
  it('accepts a realistic UUID', () => {
    expect(isSentinelValue('550E8400-E29B-41D4-A716-446655440000')).toBe(false);
  });
  it('accepts a realistic motherboard serial', () => {
    expect(isSentinelValue('C02XYZ123')).toBe(false);
  });
});

describe('hashInputs', () => {
  it('produces a 32-char hex id for valid inputs', () => {
    const id = hashInputs('user-uuid-123', 'disk-uuid-456', 'mb-serial-789');
    expect(id).toMatch(/^[a-f0-9]{32}$/);
  });
  it('is deterministic for the same inputs', () => {
    const a = hashInputs('u', 'd1234567', 'm1234567');
    const b = hashInputs('u', 'd1234567', 'm1234567');
    expect(a).toBe(b);
  });
  it('differs for different user UUIDs', () => {
    const a = hashInputs('user-A', 'd1234567', 'm1234567');
    const b = hashInputs('user-B', 'd1234567', 'm1234567');
    expect(a).not.toBe(b);
  });
  it('differs for different disk UUIDs', () => {
    const a = hashInputs('u', 'disk-A-long-enough', 'm1234567');
    const b = hashInputs('u', 'disk-B-long-enough', 'm1234567');
    expect(a).not.toBe(b);
  });
  it('differs for different motherboard serials', () => {
    const a = hashInputs('u', 'd1234567', 'mb-A-longer');
    const b = hashInputs('u', 'd1234567', 'mb-B-longer');
    expect(a).not.toBe(b);
  });
});

describe('makeFallbackId', () => {
  it('produces a random- prefixed id', () => {
    const id = makeFallbackId();
    expect(id).toMatch(/^random-[a-f0-9]{32}$/);
  });
  it('returns different values across calls', () => {
    const a = makeFallbackId();
    const b = makeFallbackId();
    expect(a).not.toBe(b);
  });
});

describe('computeClientId (with injected retrievers)', () => {
  const okDisk = async () => 'disk-UUID-aaaa-bbbb';
  const okMobo = async () => 'mobo-serial-xxxx';

  it('returns stable id when both retrievers succeed with valid values', async () => {
    const result = await computeClientId('user-1', okDisk, okMobo);
    expect(result.kind).toBe('stable');
    expect(result.id).toMatch(/^[a-f0-9]{32}$/);
  });

  it('returns same stable id for same user+hardware across calls', async () => {
    const a = await computeClientId('user-1', okDisk, okMobo);
    const b = await computeClientId('user-1', okDisk, okMobo);
    expect(a.id).toBe(b.id);
  });

  it('returns fallback when disk retriever throws', async () => {
    const failDisk = async () => {
      throw new Error('permission denied');
    };
    const result = await computeClientId('user-1', failDisk, okMobo);
    expect(result.kind).toBe('fallback');
    expect(result.id).toMatch(/^random-[a-f0-9]{32}$/);
  });

  it('returns fallback when motherboard retriever throws', async () => {
    const failMobo = async () => {
      throw new Error('wmi unavailable');
    };
    const result = await computeClientId('user-1', okDisk, failMobo);
    expect(result.kind).toBe('fallback');
  });

  it('returns fallback when disk retriever returns sentinel', async () => {
    const sentinelDisk = async () => '0000000000';
    const result = await computeClientId('user-1', sentinelDisk, okMobo);
    expect(result.kind).toBe('fallback');
  });

  it('returns fallback when motherboard retriever returns VMware sentinel', async () => {
    const vmMobo = async () => 'VMware-56 4d 8a 12';
    const result = await computeClientId('user-1', okDisk, vmMobo);
    expect(result.kind).toBe('fallback');
  });

  it('never leaks raw hardware values in returned id', async () => {
    const diskVal = 'very-identifiable-disk-UUID-1234';
    const moboVal = 'very-identifiable-mobo-serial';
    const result = await computeClientId(
      'user-1',
      async () => diskVal,
      async () => moboVal
    );
    expect(result.id).not.toContain(diskVal);
    expect(result.id).not.toContain(moboVal);
    expect(result.id).not.toContain('user-1');
  });

  it('fallback path does not hash hardware input (fresh random each call)', async () => {
    const failDisk = async () => {
      throw new Error('fail');
    };
    const a = await computeClientId('user-1', failDisk, okMobo);
    const b = await computeClientId('user-1', failDisk, okMobo);
    expect(a.id).not.toBe(b.id);
  });
});

describe('getDiskUUIDMacOS', () => {
  beforeEach(() => vi.clearAllMocks());
  it('parses Volume UUID from diskutil info output', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: any, _args: any, cb: any) => {
      cb(null, {
        stdout:
          '   Volume UUID:              550E8400-E29B-41D4-A716-446655440000\n   Other: foo\n',
        stderr: '',
      });
    }) as any);
    const uuid = await getDiskUUIDMacOS();
    expect(uuid).toBe('550E8400-E29B-41D4-A716-446655440000');
  });
  it('throws when diskutil output lacks Volume UUID line', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: any, _args: any, cb: any) => {
      cb(null, { stdout: 'no match here', stderr: '' });
    }) as any);
    await expect(getDiskUUIDMacOS()).rejects.toThrow(/volume uuid/i);
  });
  it('throws when diskutil errors out', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: any, _args: any, cb: any) => {
      cb(new Error('not found'), null);
    }) as any);
    await expect(getDiskUUIDMacOS()).rejects.toThrow();
  });
});

describe('getMotherboardSerialMacOS', () => {
  beforeEach(() => vi.clearAllMocks());
  it('parses Serial Number from system_profiler output', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: any, _args: any, cb: any) => {
      cb(null, {
        stdout: '      Serial Number (system): C02XYZ123ABC\n      Hardware UUID: ignore\n',
        stderr: '',
      });
    }) as any);
    const serial = await getMotherboardSerialMacOS();
    expect(serial).toBe('C02XYZ123ABC');
  });
  it('throws when no serial line present', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: any, _args: any, cb: any) => {
      cb(null, { stdout: 'no serial', stderr: '' });
    }) as any);
    await expect(getMotherboardSerialMacOS()).rejects.toThrow(/serial/i);
  });
});

describe('getDiskUUIDLinux', () => {
  beforeEach(() => vi.clearAllMocks());
  it('returns UUID from blkid output (after findmnt resolves device)', async () => {
    vi.mocked(execFile).mockImplementation(((cmd: any, _args: any, cb: any) => {
      if (typeof cmd === 'string' && cmd.includes('findmnt')) {
        cb(null, { stdout: '/dev/sda1\n', stderr: '' });
      } else {
        cb(null, { stdout: 'a1b2c3d4-e5f6-7890-1234-567890abcdef\n', stderr: '' });
      }
    }) as any);
    const uuid = await getDiskUUIDLinux();
    expect(uuid).toBe('a1b2c3d4-e5f6-7890-1234-567890abcdef');
  });
  it('throws when findmnt returns empty source', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: any, _args: any, cb: any) => {
      cb(null, { stdout: '\n', stderr: '' });
    }) as any);
    await expect(getDiskUUIDLinux()).rejects.toThrow();
  });
  it('throws when blkid exits non-zero', async () => {
    vi.mocked(execFile).mockImplementation(((cmd: any, _args: any, cb: any) => {
      if (typeof cmd === 'string' && cmd.includes('findmnt')) {
        cb(null, { stdout: '/dev/sda1\n', stderr: '' });
      } else {
        cb(new Error('no such device'), null);
      }
    }) as any);
    await expect(getDiskUUIDLinux()).rejects.toThrow();
  });
});

describe('getMotherboardSerialLinux', () => {
  beforeEach(() => vi.clearAllMocks());
  it('reads /sys/class/dmi/id/board_serial', async () => {
    vi.mocked(readFile).mockResolvedValue('MB-SERIAL-12345\n' as any);
    const serial = await getMotherboardSerialLinux();
    expect(serial).toBe('MB-SERIAL-12345');
  });
  it('throws when DMI file is unreadable (unprivileged user)', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('EACCES'));
    await expect(getMotherboardSerialLinux()).rejects.toThrow();
  });
  it('throws when board_serial is empty', async () => {
    vi.mocked(readFile).mockResolvedValue('\n' as any);
    await expect(getMotherboardSerialLinux()).rejects.toThrow();
  });
});

describe('getDiskUUIDWindows', () => {
  beforeEach(() => vi.clearAllMocks());
  it('parses SerialNumber from WMIC volume output', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: any, _args: any, cb: any) => {
      cb(null, { stdout: 'SerialNumber\r\n1A2B-3C4D\r\n\r\n', stderr: '' });
    }) as any);
    const id = await getDiskUUIDWindows();
    expect(id).toBe('1A2B-3C4D');
  });
  it('throws when WMIC output has no serial', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: any, _args: any, cb: any) => {
      cb(null, { stdout: 'SerialNumber\r\n\r\n', stderr: '' });
    }) as any);
    await expect(getDiskUUIDWindows()).rejects.toThrow();
  });
});

describe('getMotherboardSerialWindows', () => {
  beforeEach(() => vi.clearAllMocks());
  it('parses SerialNumber from BaseBoard WMIC output', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: any, _args: any, cb: any) => {
      cb(null, { stdout: 'SerialNumber\r\nASUS-MB-98765\r\n\r\n', stderr: '' });
    }) as any);
    const serial = await getMotherboardSerialWindows();
    expect(serial).toBe('ASUS-MB-98765');
  });
});

describe('getPlatformRetrievers', () => {
  it('returns macOS retrievers on darwin', () => {
    const { disk, mobo } = getPlatformRetrievers('darwin');
    expect(disk.name).toBe('getDiskUUIDMacOS');
    expect(mobo.name).toBe('getMotherboardSerialMacOS');
  });
  it('returns Linux retrievers on linux', () => {
    const { disk, mobo } = getPlatformRetrievers('linux');
    expect(disk.name).toBe('getDiskUUIDLinux');
    expect(mobo.name).toBe('getMotherboardSerialLinux');
  });
  it('returns Windows retrievers on win32', () => {
    const { disk, mobo } = getPlatformRetrievers('win32');
    expect(disk.name).toBe('getDiskUUIDWindows');
    expect(mobo.name).toBe('getMotherboardSerialWindows');
  });
  it('throws on unsupported platform', () => {
    expect(() => getPlatformRetrievers('aix')).toThrow(/unsupported platform/i);
  });
});

describe('computeClientId via platform dispatch (end-to-end)', () => {
  beforeEach(() => vi.clearAllMocks());
  it('falls back when platform retrievers throw', async () => {
    const { disk, mobo } = getPlatformRetrievers('darwin');
    vi.mocked(execFile).mockImplementation(((_cmd: any, _args: any, cb: any) => {
      cb(new Error('denied'), null);
    }) as any);
    const result = await computeClientId('user-1', disk, mobo);
    expect(result.kind).toBe('fallback');
  });
});
