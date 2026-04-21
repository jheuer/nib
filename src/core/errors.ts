// ─── Typed error hierarchy ────────────────────────────────────────────────────

/** Base class for all nib errors. Carry `code` for programmatic handling. */
export class NibError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'NibError'
  }
}

/** No EBB device found when auto-detecting or opening a specific port. */
export class PortNotFoundError extends NibError {
  constructor(detail?: string) {
    super(detail ? `EBB port not found: ${detail}` : 'No EBB device found', 'PORT_NOT_FOUND')
    this.name = 'PortNotFoundError'
  }
}

/** A requested move would leave the machine's safe envelope. */
export class EnvelopeViolationError extends NibError {
  constructor(
    public readonly x: number,
    public readonly y: number,
    public readonly envelope: { widthMm: number; heightMm: number },
  ) {
    super(
      `Position (${x.toFixed(1)}, ${y.toFixed(1)}) mm is outside envelope ` +
      `${envelope.widthMm}×${envelope.heightMm} mm`,
      'ENVELOPE_VIOLATION',
    )
    this.name = 'EnvelopeViolationError'
  }
}

/** Transport lost mid-job (USB disconnect, serial read error, etc.). */
export class DeviceDisconnectedError extends NibError {
  constructor(detail?: string) {
    super(detail ? `Device disconnected: ${detail}` : 'Device disconnected', 'DEVICE_DISCONNECTED')
    this.name = 'DeviceDisconnectedError'
  }
}

/** A profile or config value failed validation. */
export class ValidationError extends NibError {
  constructor(
    message: string,
    public readonly field?: string,
  ) {
    super(message, 'VALIDATION_ERROR')
    this.name = 'ValidationError'
  }
}

/** A config file could not be read or is malformed. */
export class ConfigError extends NibError {
  constructor(message: string, public readonly path?: string) {
    super(message, 'CONFIG_ERROR')
    this.name = 'ConfigError'
  }
}
