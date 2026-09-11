import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatPanel from './ChatPanel';

class SocketMock {
  static OPEN = 1;
  static instances: SocketMock[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  send = vi.fn();
  close() {}
  constructor() { SocketMock.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
}

beforeEach(() => {
  SocketMock.instances = [];
  vi.stubGlobal('WebSocket', SocketMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('chat submission', () => {
  it('keeps a draft while connecting, then sends it after the connection opens', () => {
    render(<ChatPanel />);
    const socket = SocketMock.instances[0];
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep this text' } });
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(socket.send).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue('keep this text');

    act(() => socket.open());
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'send', text: 'keep this text' }));
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('keeps unsent text across a disconnect and reconnect', () => {
    vi.useFakeTimers();
    render(<ChatPanel />);
    const socket = SocketMock.instances[0];
    act(() => socket.open());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'draft during disconnect' } });
    // The socket may have closed before the close event updates the UI.
    socket.readyState = 3;
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(socket.send).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue('draft during disconnect');
    act(() => socket.onclose?.());
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    act(() => vi.advanceTimersByTime(2500));
    const reconnected = SocketMock.instances[1];
    act(() => reconnected.open());
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(reconnected.send).toHaveBeenCalledWith(JSON.stringify({ type: 'send', text: 'draft during disconnect' }));
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('retains text if the browser rejects send', () => {
    render(<ChatPanel />);
    const socket = SocketMock.instances[0];
    act(() => socket.open());
    socket.send.mockImplementation(() => { throw new DOMException('Socket closed', 'InvalidStateError'); });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'retry me' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(screen.getByRole('textbox')).toHaveValue('retry me');
  });

  it('does not send IME candidate confirmation or Shift+Enter', () => {
    render(<ChatPanel />);
    const socket = SocketMock.instances[0];
    act(() => socket.open());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'zhongwen' } });
    fireEvent.compositionStart(screen.getByRole('textbox'));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(socket.send).not.toHaveBeenCalled();
    fireEvent.compositionEnd(screen.getByRole('textbox'));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: true });
    expect(socket.send).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue('zhongwen');

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '中文' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(socket.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: 'send', text: '中文' }));
    expect(screen.getByRole('textbox')).toHaveValue('');
  });
});
