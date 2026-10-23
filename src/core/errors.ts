/** A caller supplied an invalid opaque event-list cursor. */
export class InvalidPageCursorError extends TypeError {
  constructor(options?: ErrorOptions) {
    super('cursor must be a valid event page cursor.', options);
    this.name = 'InvalidPageCursorError';
  }
}
