'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fields = ['ownerId', 'id', 'taskKey', 'sourceId', 'contextRevision', 'action'];
const signature = (input) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify([...fields.map((k) => input[k]), input.text || '']))
    .digest('hex');
class ActionJournal {
  constructor(directory) {
    this.file = path.join(directory, 'recovery.json');
    this.value = { version: 1, events: [], fixture: null, scenario: 'quiet' };
    this.error = '';
    this.fail = false;
    try {
      if (fs.existsSync(this.file)) {
        const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (value.version !== 1 || !Array.isArray(value.events)) throw new Error('Invalid journal');
        this.value = value;
        for (const event of this.value.events)
          if (event.state === 'inFlight') {
            event.state = 'uncertain';
            event.ownerAccepted = false;
          }
      }
    } catch {
      this.error =
        'Saved action recovery cannot be read. Actions are paused; existing recovery data was preserved.';
    }
  }
  save() {
    if (this.error || this.fail)
      throw new Error(
        this.error || 'Local action storage is unavailable. No owner action was dispatched.',
      );
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    const descriptor = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(this.value));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, this.file);
  }
  existing(input) {
    const event = this.value.events.find((e) => e.eventId === input.eventId);
    if (event && event.signature !== signature(input))
      throw new Error('This event ID belongs to a different action.');
    return event;
  }
  begin(input) {
    const record = {
      eventId: input.eventId,
      ...Object.fromEntries(fields.map((k) => [k, input[k]])),
      signature: signature(input),
      state: 'inFlight',
      ownerAccepted: false,
      providerAccepted: true,
    };
    this.value.events.push(record);
    try {
      this.save();
    } catch (error) {
      this.value.events.pop();
      throw error;
    }
    return record;
  }
  receipt(record, result) {
    Object.assign(record, result);
    this.save();
  }
  publicEvents() {
    return this.value.events.map(({ signature, ...event }) => event);
  }
}
module.exports = { ActionJournal, signature };
