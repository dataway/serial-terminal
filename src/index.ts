/**
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {WebLinksAddon} from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

declare global {
  interface Window {
    RELEASE_VERSION?: string;
  }
}

let connect9600Button: HTMLButtonElement;
let connect115200Button: HTMLButtonElement;
let disconnectButton: HTMLButtonElement;
let sendBreakButton: HTMLButtonElement;
let sendBreakWrap: HTMLSpanElement;
let statusLabel: HTMLSpanElement;
let dcdSignal: HTMLSpanElement;
let dsrSignal: HTMLSpanElement;
let riSignal: HTMLSpanElement;
let ctsSignal: HTMLSpanElement;
let rxCounter: HTMLSpanElement;
let txCounter: HTMLSpanElement;
let termSizeBadge: HTMLDivElement;

let port: SerialPort | undefined;
let reader: ReadableStreamDefaultReader | ReadableStreamBYOBReader | undefined;
let signalPollTimer: ReturnType<typeof setInterval> | undefined;
let termSizeBadgeTimer: ReturnType<typeof setTimeout> | undefined;
let rxBytes = 0;
let txBytes = 0;

const bufferSize = 8 * 1024; // 8kB

// Add "?breaktest" to URL for the test mode
const breakTestMode = new URLSearchParams(window.location.search)
    .has('breaktest');

const term = new Terminal({
  scrollback: 10_000,
  theme: {
    background: '#16181d',
    foreground: '#d4d4d4',
  },
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

term.loadAddon(new WebLinksAddon());

/**
 * Formats a byte count for display with thousands separators, e.g.
 * `12,345 B`.
 *
 * @param {number} bytes the number of bytes
 * @return {string} the formatted byte count
 */
function formatByteCount(bytes: number): string {
  return `${bytes.toLocaleString()} B`;
}

/**
 * Resets the sent/received byte counters back to zero.
 */
function resetByteCounters(): void {
  rxBytes = 0;
  txBytes = 0;
  rxCounter.textContent = `⬇ ${formatByteCount(rxBytes)}`;
  txCounter.textContent = `⬆ ${formatByteCount(txBytes)}`;
}

const encoder = new TextEncoder();
term.onData((data) => {
  if (port?.writable == null) {
    console.warn(`unable to find writable port`);
    return;
  }

  const bytes = encoder.encode(data);
  const writer = port.writable.getWriter();
  writer.write(bytes);
  writer.releaseLock();

  txBytes += bytes.length;
  txCounter.textContent = `⬆ ${formatByteCount(txBytes)}`;
});

/**
 * Download the terminal's contents to a file.
 */
function downloadTerminalContents(): void {
  if (!term) {
    throw new Error('no terminal instance found');
  }

  if (term.rows === 0) {
    console.log('No output yet');
    return;
  }

  term.selectAll();
  const contents = term.getSelection();
  term.clearSelection();
  const linkContent = URL.createObjectURL(
      new Blob([new TextEncoder().encode(contents).buffer],
          {type: 'text/plain'}));
  const fauxLink = document.createElement('a');
  fauxLink.download = `terminal_content_${new Date().getTime()}.txt`;
  fauxLink.href = linkContent;
  fauxLink.click();
}

/**
 * Writes a blank line at the very top of the buffer. Combined with
 * `fitTerminal()`'s bottom-anchoring (which can clip the topmost visible
 * row), this guarantees that scrolling all the way back to the start of the
 * buffer never hides real content behind that clipped row — it's always
 * this blank line instead.
 */
function seedLeadingBlankLine(): void {
  term.writeln('');
}

function writeVersionBanner(): void {
  const version = window.RELEASE_VERSION;
  writeStatusLine(90, '⭐',
    version ? `serial-terminal ${version}` : 'serial-terminal');
}

/**
 * Clear the terminal's contents.
 */
function clearTerminalContents(): void {
  if (!term) {
    throw new Error('no terminal instance found');
  }

  if (term.rows === 0) {
    console.log('No output yet');
    return;
  }

  term.clear();
  seedLeadingBlankLine();
}

async function logBreakTestTimestamp(label: string): Promise<void> {
  const line = `[breaktest] ${label}: ${performance.now().toFixed(3)}ms`;
  console.log(line);
  writeStatusLine(36, '🐞', line);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Send an RS232 break lasting 250ms
 */
async function sendRs232Break(): Promise<void> {
  if (!port) {
    return;
  }
  console.log('Start RS232 break');
  if (breakTestMode) {
    await logBreakTestTimestamp('before setSignals(break: true)');
  }
  await port.setSignals({'break': true});
  if (breakTestMode) {
    await logBreakTestTimestamp('after setSignals(break: true)');
  }
  setTimeout(() => {
    console.log('End RS232 break');
    if (!port) {
      return;
    }
    port.setSignals({'break': false});
  }, 250);
}

/**
 * Writes a status line to the terminal in a distinct color with a marker
 * emoji, so it's clear the line is coming from the app, not the device.
 *
 * @param {number} ansiColor the ANSI SGR color code, e.g. 31 for red
 * @param {string} emoji the marker emoji to prefix the line with
 * @param {string} text the line to write
 * @param {() => void} callback called once the line has been written
 */
function writeStatusLine(
    ansiColor: number, emoji: string, text: string,
    callback?: () => void): void {
  term.writeln(`\x1b[${ansiColor}m${emoji}  ${text}\x1b[0m`, callback);
}

/**
 * Writes an error message to the terminal in a distinct color with a marker
 * emoji, so it's clear the line didn't come from the connected device.
 *
 * @param {string} message the error message
 * @param {() => void} callback called once the message has been written
 */
function writeError(message: string, callback?: () => void): void {
  writeStatusLine(31, '⚠️', `<ERROR: ${message}>`, callback);
}

/**
 * Prompts the user to select a port.
 *
 * @return {SerialPort | undefined} the selected port
 */
async function selectPort(): Promise<SerialPort | undefined> {
  try {
    return await navigator.serial.requestPort({});
  } catch {
    return undefined;
  }
}

/**
 * Returns a port's USB vendor/product ID as a lowercase `vvvv:pppp` string,
 * or undefined if the port isn't a USB device (or the browser won't say).
 *
 * @param {SerialPort} port the port to identify
 * @return {string | undefined} the USB ID, or undefined if unavailable
 */
function getUsbId(port: SerialPort): string | undefined {
  const info = port.getInfo();
  if (info.usbVendorId === undefined || info.usbProductId === undefined) {
    return undefined;
  }
  const vid = info.usbVendorId.toString(16).padStart(4, '0');
  const pid = info.usbProductId.toString(16).padStart(4, '0');
  return `${vid}:${pid}`;
}

/**
 * Builds a human-readable label for a port from whatever identifying
 * information the browser is willing to share. The Web Serial API does not
 * expose a friendly device name, only its USB vendor/product IDs (when the
 * underlying device is a USB device).
 *
 * @param {SerialPort} port the port to describe
 * @return {string} the port label, or an empty string if none is available
 */
function describePort(port: SerialPort): string {
  const usbId = getUsbId(port);
  return usbId ? `USB ${usbId.toUpperCase()}` : '';
}

// USB devices tested and verified to handle a break signal correctly on Windows
const BREAK_SAFE_USB_IDS = new Set([
  '0403:6001', // FTDI FT232R
  '067b:2303', // Prolific PL2303
]);

/**
 * Returns true if it's safe to offer the "Send break" button for this port.
 *
 * On Windows, `usbser.sys` implements a break as a USB CDC `SEND_BREAK`
 * control request, and some USB-to-serial adapters (observed with a Cisco
 * console cable, VID:PID 05a6:0009) don't handle that request correctly,
 * which can hang the entire browser process rather than just the page. This
 * hasn't been observed on Linux or macOS, so the restriction only applies
 * on Windows, and only to devices that haven't been verified safe.
 *
 * @param {SerialPort} port the connected port
 * @return {boolean} whether "Send break" should be enabled
 */
function isSendBreakSafe(port: SerialPort): boolean {
  if (breakTestMode || !navigator.userAgent.includes('Windows')) {
    return true;
  }
  const usbId = getUsbId(port);
  return usbId !== undefined && BREAK_SAFE_USB_IDS.has(usbId);
}

/**
 * Polls and displays the state of the DCD/DSR/RI/CTS control signals.
 */
async function pollSignals(): Promise<void> {
  if (!port) {
    return;
  }
  try {
    const signals = await port.getSignals();
    dcdSignal.classList.toggle('active', signals.dataCarrierDetect);
    dsrSignal.classList.toggle('active', signals.dataSetReady);
    riSignal.classList.toggle('active', signals.ringIndicator);
    ctsSignal.classList.toggle('active', signals.clearToSend);
  } catch (e) {
    console.error(e);
  }
}

/**
 * Resets the UI back to the disconnected state.
 */
function markDisconnected(): void {
  writeStatusLine(33, '🔌', '<DISCONNECTED>');
  connect9600Button.hidden = false;
  connect9600Button.disabled = false;
  connect9600Button.textContent = 'Connect 9600';
  connect115200Button.hidden = false;
  connect115200Button.disabled = false;
  connect115200Button.textContent = 'Connect 115200';
  disconnectButton.hidden = true;
  sendBreakButton.disabled = true;
  sendBreakWrap.title = '';
  statusLabel.hidden = true;
  statusLabel.textContent = '';
  if (signalPollTimer !== undefined) {
    clearInterval(signalPollTimer);
    signalPollTimer = undefined;
  }
  for (const signal of [dcdSignal, dsrSignal, riSignal, ctsSignal]) {
    signal.classList.remove('active');
  }
  port = undefined;
}

/**
 * Initiates a connection to a newly selected port.
 *
 * @param {number} baudRate the baud rate to connect at
 * @param {HTMLButtonElement} button the button that was clicked
 */
async function connectToPort(
    baudRate: number, button: HTMLButtonElement): Promise<void> {
  port = await selectPort();
  if (!port) {
    return;
  }

  const options: SerialOptions = {
    baudRate,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    flowControl: 'none',
    bufferSize,
  };
  console.log(options);

  connect9600Button.disabled = true;
  connect115200Button.disabled = true;
  button.textContent = 'Connecting...';
  resetByteCounters();

  try {
    await port.open(options);
    writeStatusLine(32, '✅', '<CONNECTED>');
    connect9600Button.hidden = true;
    connect115200Button.hidden = true;

    const portLabel = describePort(port);
    statusLabel.textContent = '';
    statusLabel.append(`Connected - ${baudRate}`);
    if (portLabel) {
      const portName = document.createElement('span');
      portName.className = 'port-name';
      portName.textContent = ` (${portLabel})`;
      statusLabel.append(portName);
    }
    statusLabel.hidden = false;

    disconnectButton.hidden = false;
    disconnectButton.disabled = false;

    if (isSendBreakSafe(port)) {
      sendBreakButton.disabled = false;
      sendBreakWrap.title = '';
    } else {
      sendBreakButton.disabled = true;
      sendBreakWrap.title = 'Disabled for this device on Windows: some ' +
          'USB-to-serial adapters (e.g. the Cisco console cable) can ' +
          'freeze the whole browser when a break signal is sent.';
    }

    signalPollTimer = setInterval(pollSignals, 200);
  } catch (e) {
    console.error(e);
    if (e instanceof Error) {
      writeError(e.message);
    }
    markDisconnected();
    return;
  }

  while (port && port.readable) {
    try {
      try {
        reader = port.readable.getReader({mode: 'byob'});
      } catch {
        reader = port.readable.getReader();
      }

      let buffer = null;
      for (;;) {
        const {value, done} = await (async () => {
          if (reader instanceof ReadableStreamBYOBReader) {
            if (!buffer) {
              buffer = new ArrayBuffer(bufferSize);
            }
            const {value, done} =
                await reader.read(new Uint8Array(buffer, 0, bufferSize));
            buffer = value?.buffer;
            return {value, done};
          } else {
            return await reader.read();
          }
        })();

        if (value) {
          rxBytes += value.length;
          rxCounter.textContent = `⬇ ${formatByteCount(rxBytes)}`;
          await new Promise<void>((resolve) => {
            term.write(value, resolve);
          });
        }
        if (done) {
          break;
        }
      }
    } catch (e) {
      console.error(e);
      await new Promise<void>((resolve) => {
        if (e instanceof Error) {
          writeError(e.message, resolve);
        }
      });
    } finally {
      if (reader) {
        reader.releaseLock();
        reader = undefined;
      }
    }
  }

  if (port) {
    try {
      await port.close();
    } catch (e) {
      console.error(e);
      if (e instanceof Error) {
        writeError(e.message);
      }
    }

    markDisconnected();
  }
}

/**
 * Closes the currently active connection.
 */
async function disconnectFromPort(): Promise<void> {
  // Move |port| into a local variable so that connectToPort() doesn't try to
  // close it on exit.
  const localPort = port;
  port = undefined;

  if (reader) {
    await reader.cancel();
  }

  if (localPort) {
    try {
      await localPort.close();
    } catch (e) {
      console.error(e);
      if (e instanceof Error) {
        writeError(e.message);
      }
    }
  }

  markDisconnected();
}

// Default terminal sizing targets. Adjust these if requirements change.
const DEFAULT_FONT_SIZE = 15;
const MIN_FONT_SIZE = 8;
const MIN_COLS = 80;
const MAX_COLS = 160;
const MIN_ROWS = 25;

/**
 * Picks a font size for the terminal based on how much space is available:
 * - Below `MIN_COLS` columns at the default font size, shrinks the font
 *   (down to `MIN_FONT_SIZE`) until `MIN_COLS` columns fit. If it's still
 *   not enough space at `MIN_FONT_SIZE`, the terminal ends up narrower than
 *   `MIN_COLS` columns rather than shrinking further.
 * - Above `MAX_COLS` columns at the default font size, grows the font as
 *   far as it can while keeping at least `MAX_COLS` columns and at least
 *   `MIN_ROWS` rows, so very wide windows don't produce excessively long
 *   lines.
 * - Otherwise leaves the font at its default size.
 */
function applyResponsiveFontSize(): void {
  term.options.fontSize = DEFAULT_FONT_SIZE;
  const defaultDims = fitAddon.proposeDimensions();
  if (!defaultDims) {
    return;
  }

  if (defaultDims.cols < MIN_COLS) {
    for (let size = DEFAULT_FONT_SIZE - 1; size >= MIN_FONT_SIZE; size--) {
      term.options.fontSize = size;
      const dims = fitAddon.proposeDimensions();
      if (dims && dims.cols >= MIN_COLS) {
        break;
      }
    }
  } else if (defaultDims.cols > MAX_COLS) {
    let bestSize = DEFAULT_FONT_SIZE;
    for (let size = DEFAULT_FONT_SIZE + 1; size <= 500; size++) {
      term.options.fontSize = size;
      const dims = fitAddon.proposeDimensions();
      if (!dims || dims.cols < MAX_COLS || dims.rows < MIN_ROWS) {
        break;
      }
      bestSize = size;
    }
    term.options.fontSize = bestSize;
  }
}

/**
 * Fits the terminal to its container, then — if the container's height
 * isn't an exact multiple of the line height — grows the terminal by one
 * extra row. Combined with the `#terminal` CSS (`justify-content: flex-end`
 * plus `overflow: hidden`), this keeps the bottom row always flush with the
 * bottom border, pushing any partial row of empty space to the top instead
 * of leaving a gap (or an overflowing row) at the bottom.
 */
function fitTerminal(): void {
  applyResponsiveFontSize();
  fitAddon.fit();
  const rendered = term.element;
  if (!rendered || term.rows === 0) {
    return;
  }
  const leftover = rendered.parentElement!.clientHeight - rendered.clientHeight;
  if (leftover > 0) {
    term.resize(term.cols, term.rows + 1);
  }
}

/**
 * Briefly shows the terminal's current size in characters, e.g. `127x34`,
 * fading it back out shortly after the window stops being resized.
 */
function showTermSizeBadge(): void {
  termSizeBadge.textContent = `${term.cols}x${term.rows}`;
  termSizeBadge.hidden = false;
  if (termSizeBadgeTimer !== undefined) {
    clearTimeout(termSizeBadgeTimer);
  }
  termSizeBadgeTimer = setTimeout(() => {
    termSizeBadge.hidden = true;
    termSizeBadgeTimer = undefined;
  }, 800);
}

document.addEventListener('DOMContentLoaded', () => {
  termSizeBadge = document.getElementById('term-size') as HTMLDivElement;

  const terminalElement = document.getElementById('terminal');
  if (terminalElement) {
    term.open(terminalElement);
    seedLeadingBlankLine();
    writeVersionBanner();
    fitTerminal();

    window.addEventListener('resize', () => {
      fitTerminal();
      showTermSizeBadge();
    });
  }

  const downloadOutput =
    document.getElementById('download') as HTMLSelectElement;
  downloadOutput.addEventListener('click', downloadTerminalContents);

  const clearOutput = document.getElementById('clear') as HTMLSelectElement;
  clearOutput.addEventListener('click', clearTerminalContents);

  sendBreakWrap = document.getElementById('break-wrap') as HTMLSpanElement;
  sendBreakButton = document.getElementById('break') as HTMLButtonElement;
  sendBreakButton.disabled = true;
  sendBreakButton.addEventListener('click', () => {
    term.focus();
    sendRs232Break();
  });

  connect9600Button =
      document.getElementById('connect9600') as HTMLButtonElement;
  connect9600Button.addEventListener(
      'click', () => connectToPort(9600, connect9600Button));

  connect115200Button =
      document.getElementById('connect115200') as HTMLButtonElement;
  connect115200Button.addEventListener(
      'click', () => connectToPort(115200, connect115200Button));

  disconnectButton =
      document.getElementById('disconnect') as HTMLButtonElement;
  disconnectButton.addEventListener('click', () => {
    disconnectButton.disabled = true;
    disconnectFromPort();
  });

  statusLabel = document.getElementById('status') as HTMLSpanElement;

  dcdSignal = document.getElementById('signal-dcd') as HTMLSpanElement;
  dsrSignal = document.getElementById('signal-dsr') as HTMLSpanElement;
  riSignal = document.getElementById('signal-ri') as HTMLSpanElement;
  ctsSignal = document.getElementById('signal-cts') as HTMLSpanElement;

  rxCounter = document.getElementById('counter-rx') as HTMLSpanElement;
  txCounter = document.getElementById('counter-tx') as HTMLSpanElement;
});
