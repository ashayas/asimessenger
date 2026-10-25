import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { launchApp } from './helpers'

test('Invite button adds multiple agents to a thread with a shared grep-searchable session board log', async () => {
  const h = await launchApp({ seed: true })
  try {
    const opened = h.app.waitForEvent('window')
    await h.win.locator('[data-friend="Echo"]').dblclick()
    const chat = await opened

    // 1. Open Invite & Shared Session Board panel
    await chat.getByRole('button', { name: 'Invite' }).click()
    const panel = chat.getByTestId('invite-panel')
    await expect(panel).toBeVisible()

    // 2. Set overall session goal
    await panel.getByLabel('Session goal').fill('Ship multi-agent collaboration board')
    await panel.getByRole('button', { name: 'Save Goal' }).click()

    // 3. Invite a second Echo agent (same harness/model type) with a custom role
    await panel.getByLabel('Invite friend').selectOption({ label: 'Echo (echo)' })
    await panel.getByLabel('Agent role').fill('QA reviewer')
    await panel.getByRole('button', { name: '+ Add Agent' }).click()

    // Both echo-1 and echo-2 appear in the participant roster
    const roster = panel.getByTestId('participant-roster')
    await expect(roster.locator('[data-agent-id="echo-1"]')).toBeVisible()
    await expect(roster.locator('[data-agent-id="echo-2"]')).toContainText('Echo #2')
    await expect(roster.locator('[data-agent-id="echo-2"]')).toContainText('QA reviewer')

    // 4. Send a collaborative message to all agents in the thread
    await chat.getByLabel('Message').fill('Check our shared goal and report status')
    await chat.getByLabel('Message').press('Enter')

    // Both agents respond under their own speaker headers
    await expect(chat.locator('.says', { hasText: 'Echo [echo-1]' })).toBeVisible()
    await expect(chat.locator('.says', { hasText: 'Echo #2 [echo-2]' })).toBeVisible()

    // 5. Open the Board log viewer inside the Invite panel and test grep filtering
    await panel.getByRole('button', { name: /View Log/ }).click()
    const logPre = panel.getByTestId('board-log-pre')
    await expect(logPre).toContainText('# GOAL: Ship multi-agent collaboration board')
    await expect(logPre).toContainText('agent_id=echo-1')
    await expect(logPre).toContainText('agent_id=echo-2')
    await expect(logPre).toContainText('AGENT=echo-2')

    // Filter with grep input
    await panel.getByLabel('Grep board').fill('AGENT=echo-2')
    await expect(logPre).toContainText('AGENT=echo-2')

    // Verify the on-disk .boards/<chatId>.log file exists and has the goal at the top
    const pathText = await panel.locator('.board-path').getAttribute('title')
    expect(pathText).toBeTruthy()
    expect(existsSync(pathText!)).toBe(true)
    const diskLog = readFileSync(pathText!, 'utf8')
    expect(diskLog).toContain('# [GOAL]')
    expect(diskLog).toContain('# GOAL: Ship multi-agent collaboration board')
    expect(diskLog).toContain('AGENT=echo-1')
    expect(diskLog).toContain('AGENT=echo-2')
  } finally {
    await h.cleanup()
  }
})
