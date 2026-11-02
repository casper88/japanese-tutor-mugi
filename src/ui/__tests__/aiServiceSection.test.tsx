// @vitest-environment jsdom
// Settings › AI 服務 (SettingsSections AiServiceSection): the rows in the player's order, 上移／下移, the switches (the last one
// on cannot be turned off), the ChatGPT sign-in (only on the PC), the model choice, and the sign-in's failure message.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AiServiceSection } from '../SettingsSections';
import type { ChatGptStatus } from '../../game/openaiStatus';

function render(node: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

const SIGNED_IN: ChatGptStatus = {
  signedIn: true, planEnabled: true, email: 'me@example.com',
  models: [{ slug: 'gpt-5.5-sol', label: 'GPT 5.5 Sol' }, { slug: 'gpt-5.4', label: 'GPT 5.4' }],
};
const SIGNED_OUT: ChatGptStatus = { signedIn: false, planEnabled: false, models: [] };

const button = (host: HTMLElement, label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;
const switchOf = (host: HTMLElement, label: string) => host.querySelector(`input[aria-label="${label} 使用"]`) as HTMLInputElement;
const rowLabels = (host: HTMLElement) => [...host.querySelectorAll('.as-ai-item > .as-row > span:first-child')].map((s) => s.childNodes[0]?.textContent);

afterEach(() => {
  document.body.innerHTML = '';
});

describe('AiServiceSection', () => {
  it('lists the services in the order the player keeps them; a service that is off comes after', () => {
    const r = render(<AiServiceSection providers={['openai', 'anthropic']} openaiModel="" claudeOk chatgpt={SIGNED_IN} onChange={() => {}} onRefresh={() => {}} localPc />);
    expect(r.host.querySelector('h3')?.textContent).toBe('AI 服務');
    expect(rowLabels(r.host)).toEqual(['ChatGPT', 'Claude', '本地模型']);
    r.unmount();
    const off = render(<AiServiceSection providers={['anthropic']} openaiModel="" claudeOk chatgpt={SIGNED_OUT} onChange={() => {}} onRefresh={() => {}} localPc />);
    expect(rowLabels(off.host)).toEqual(['Claude', 'ChatGPT', '本地模型']);
    off.unmount();
  });

  it('上移 swaps the row with the one above and saves the new order', () => {
    const onChange = vi.fn();
    const r = render(<AiServiceSection providers={['anthropic', 'openai']} openaiModel="" claudeOk chatgpt={SIGNED_IN} onChange={onChange} onRefresh={() => {}} localPc />);
    const up = r.host.querySelector('button[aria-label="ChatGPT 上移"]') as HTMLButtonElement;
    expect(up.disabled).toBe(false);
    act(() => up.click());
    expect(onChange).toHaveBeenCalledWith({ providers: ['openai', 'anthropic'] });
    expect((r.host.querySelector('button[aria-label="Claude 上移"]') as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
  });

  it('the last service that is on cannot be switched off; turning a service on adds it to the end', () => {
    const onChange = vi.fn();
    const r = render(<AiServiceSection providers={['anthropic']} openaiModel="" claudeOk chatgpt={SIGNED_IN} onChange={onChange} onRefresh={() => {}} localPc />);
    expect(switchOf(r.host, 'Claude').checked).toBe(true);
    expect(switchOf(r.host, 'Claude').disabled).toBe(true);
    act(() => switchOf(r.host, 'ChatGPT').click());
    expect(onChange).toHaveBeenCalledWith({ providers: ['anthropic', 'openai'] });
    r.unmount();
  });

  it('with both on, switching one off keeps the other', () => {
    const onChange = vi.fn();
    const r = render(<AiServiceSection providers={['openai', 'anthropic']} openaiModel="" claudeOk chatgpt={SIGNED_IN} onChange={onChange} onRefresh={() => {}} localPc />);
    act(() => switchOf(r.host, 'ChatGPT').click());
    expect(onChange).toHaveBeenCalledWith({ providers: ['anthropic'] });
    r.unmount();
  });

  it('the Claude row says whether its key is set', () => {
    const r = render(<AiServiceSection providers={['anthropic']} openaiModel="" claudeOk={false} chatgpt={SIGNED_OUT} onChange={() => {}} onRefresh={() => {}} localPc />);
    expect(r.host.textContent).toContain('未設定金鑰（在電腦的 .env.local 填 ANTHROPIC_API_KEY）');
    r.unmount();
  });

  it('from a phone there is no sign-in button and no paste field: the note says ChatGPT signs in and out only on the PC', () => {
    const r = render(<AiServiceSection providers={['anthropic']} openaiModel="" claudeOk chatgpt={SIGNED_OUT} onChange={() => {}} onRefresh={() => {}} localPc={false} />);
    expect(button(r.host, '用 ChatGPT 登入')).toBeUndefined();
    expect(r.host.querySelector('input[aria-label="登入後的網址"]')).toBeNull();
    expect(r.host.textContent).toContain('ChatGPT 只能在電腦上登入或登出');
    r.unmount();
  });

  it('from a phone, signed in: no 登出 button, but the model select still works', () => {
    const onChange = vi.fn();
    const r = render(<AiServiceSection providers={['openai']} openaiModel="gpt-5.4" claudeOk chatgpt={SIGNED_IN} onChange={onChange} onRefresh={() => {}} localPc={false} />);
    expect(r.host.textContent).toContain('已登入（me@example.com）');
    expect(button(r.host, '登出')).toBeUndefined();
    const select = r.host.querySelector('select[aria-label="ChatGPT 模型"]') as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    act(() => {
      select.value = 'gpt-5.5-sol';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ openaiModel: 'gpt-5.5-sol' });
    r.unmount();
  });

  it('from a phone the Claude key is a status line only: no key box and no save button', () => {
    const r = render(<AiServiceSection providers={['anthropic']} openaiModel="" claudeOk chatgpt={SIGNED_OUT} onChange={() => {}} onRefresh={() => {}} localPc={false} />);
    expect(r.host.querySelector('input[aria-label="Claude 金鑰"]')).toBeNull();
    expect(r.host.textContent).toContain('金鑰只能在電腦上設定');
    r.unmount();
  });

  it('signed in: the status shows the account, 登出 is there, and a model select lists the plan’s models', () => {
    const onChange = vi.fn();
    const r = render(<AiServiceSection providers={['openai']} openaiModel="gpt-5.4" claudeOk chatgpt={SIGNED_IN} onChange={onChange} onRefresh={() => {}} localPc />);
    expect(r.host.textContent).toContain('已登入（me@example.com）');
    expect(button(r.host, '用 ChatGPT 登入')).toBeUndefined();
    expect(button(r.host, '登出')).toBeDefined();
    const select = r.host.querySelector('select[aria-label="ChatGPT 模型"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['gpt-5.5-sol', 'gpt-5.4']);
    expect(select.value).toBe('gpt-5.4');
    act(() => {
      select.value = 'gpt-5.5-sol';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ openaiModel: 'gpt-5.5-sol' });
    r.unmount();
  });

  it('a model that is not listed shows the first listed one', () => {
    const r = render(<AiServiceSection providers={['openai']} openaiModel="gone" claudeOk chatgpt={SIGNED_IN} onChange={() => {}} onRefresh={() => {}} localPc />);
    expect((r.host.querySelector('select[aria-label="ChatGPT 模型"]') as HTMLSelectElement).value).toBe('gpt-5.5-sol');
    r.unmount();
  });

  it('a note says the ChatGPT sign-in uses the plan and is not shared', () => {
    const r = render(<AiServiceSection providers={['anthropic']} openaiModel="" claudeOk chatgpt={SIGNED_OUT} onChange={() => {}} onRefresh={() => {}} localPc />);
    expect(r.host.textContent).toContain('不需要 OpenAI API 金鑰');
    r.unmount();
  });

  it('本地模型: its status line, the models its server lists, 重新偵測, and the address boxes only on the PC', () => {
    const onRefreshLocal = vi.fn();
    const local = { ok: true, url: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', models: ['qwen3:8b', 'gemma3:4b'] };
    const pc = render(<AiServiceSection providers={['local']} openaiModel="" claudeOk={false} chatgpt={SIGNED_OUT} local={local}
      onChange={() => {}} onRefresh={() => {}} onRefreshLocal={onRefreshLocal} localPc />);
    expect(rowLabels(pc.host)[0]).toBe('本地模型');
    expect(pc.host.textContent).toContain('已連線（qwen3:8b）');
    expect(pc.host.textContent).toContain('可用模型：qwen3:8b、gemma3:4b');
    expect(pc.host.querySelector('input[aria-label="本地模型網址"]')).not.toBeNull();
    act(() => button(pc.host, '重新偵測').click());
    expect(onRefreshLocal).toHaveBeenCalledTimes(1);
    pc.unmount();
    const phone = render(<AiServiceSection providers={['local']} openaiModel="" claudeOk={false} chatgpt={SIGNED_OUT}
      local={{ ok: false, url: '', model: '', models: [], message: '連不上本地模型服務' }} onChange={() => {}} onRefresh={() => {}} localPc={false} />);
    expect(phone.host.textContent).toContain('連不上本地模型服務');
    expect(phone.host.querySelector('input[aria-label="本地模型網址"]')).toBeNull();
    expect(phone.host.textContent).toContain('網址和模型名稱只能在電腦上設定');
    phone.unmount();
  });
});
