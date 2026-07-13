export interface RandomAccessWriter {
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesWritten: number }>
}

export async function writeAll(
  writer: RandomAccessWriter,
  bytes: Uint8Array,
  position: number,
): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await writer.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      position + offset,
    )
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.byteLength - offset) {
      throw new Error('Filesystem write made invalid progress')
    }
    offset += bytesWritten
  }
}
