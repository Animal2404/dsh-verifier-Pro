import React from 'react'
import { createRoot } from 'react-dom/client'

// DSH Client Plugin Entry Point
// This file is the entry point for the client-side bundle

// Register the Verifier panel to DSH client UI slots
// This is called by the DSH client runtime when the plugin loads
export function activate(ctx: any) {
  // Register the Verifier panel in the sidebar
  ctx.ui.slots.add('sidebar', {
    id: 'verifier',
    label: 'Verifier',
    icon: '🔍',
    component: VerifierPanel,
    order: 100,
  })

  // Register settings page
  ctx.ui.slots.add('settings', {
    id: 'verifier-settings',
    label: 'Verifier',
    icon: '⚙️',
    component: VerifierSettingsPanel,
    category: 'plugins',
    order: 100,
  })

  console.log('[dsh-verifier-Pro] Client plugin activated')
}

// Main Verifier Panel Component
export function VerifierPanel({ ctx }: { ctx: any }) {
  const [history, setHistory] = React.useState<any[]>([])
  const [selectedRun, setSelectedRun] = React.useState<any>(null)

  React.useEffect(() => {
    // Subscribe to verifier events
    const unsub = ctx.events.on('verifier/*', (event: any) => {
      if (event.type === 'verifier/select' || event.type === 'verifier/compare') {
        setHistory((prev: any[]) => [event, ...prev.slice(0, 49)])
      }
    })
    return unsub
  }, [ctx])

  if (!selectedRun) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <h2 style={styles.title}>🔍 Verifier</h2>
          <span style={styles.badge}>Ready</span>
        </div>
        <div style={styles.history}>
          {history.length === 0 ? (
            <p style={styles.empty}>暂无验证记录\n运行 verifier select/compare 后将显示这里</p>
          ) : (
            <ul style={styles.list}>
              {history.map((run: any, i: number) => (
                <li key={i} style={styles.item} onClick={() => setSelectedRun(run)}>
                  <span style={styles.runType}>{run.type === 'verifier/select' ? '🏆 Select' : '⚖️ Compare'}</span>
                  <span style={styles.runTime}>{new Date(run.ts).toLocaleTimeString()}</span>
                  <span style={styles.runModel}>{run.model || 'default'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>🔍 Verifier Detail</h2>
        <button style={styles.backButton} onClick={() => setSelectedRun(null)}>← 返回</button>
      </div>
      <div style={styles.detail}>
        <pre style={styles.pre}>{JSON.stringify(selectedRun, null, 2)}</pre>
      </div>
    </div>
  )
}

// Settings Panel Component
export function VerifierSettingsPanel({ ctx }: { ctx: any }) {
  const [config, setConfig] = React.useState(() => ctx.config.get('verifier') || {})

  const handleChange = (key: string, value: any) => {
    setConfig((prev: Record<string, any>) => ({ ...prev, [key]: value }))
  }

  const handleSave = () => {
    ctx.config.set('verifier', config)
    ctx.toast.success('配置已保存，重启 DSH 生效')
  }

  return (
    <div style={styles.settingsContainer}>
      <h3 style={styles.settingsTitle}>Verifier 配置</h3>
      
      <div style={styles.field}>
        <label style={styles.label}>默认评分模型</label>
        <input
          style={styles.input}
          value={config.verifierModel || ''}
          onChange={e => handleChange('verifierModel', e.target.value)}
          placeholder="deepseek-chat"
        />
      </div>

      <div style={styles.field}>
        <label style={styles.label}>后端 Base URL</label>
        <input
          style={styles.input}
          value={config.backendBaseUrl || ''}
          onChange={e => handleChange('backendBaseUrl', e.target.value)}
          placeholder="https://api.deepseek.com"
        />
      </div>

      <div style={styles.field}>
        <label style={styles.label}>后端 API Key</label>
        <input
          style={styles.input}
          type="password"
          value={config.backendApiKey || ''}
          onChange={e => handleChange('backendApiKey', e.target.value)}
          placeholder="从 ~/.dsh/.credentials.yaml 读取或在此设置"
        />
      </div>

      <div style={styles.field}>
        <label style={styles.label}>桥超时 (ms)</label>
        <input
          style={styles.input}
          type="number"
          value={config.bridgeTimeoutMs || 300000}
          onChange={e => handleChange('bridgeTimeoutMs', parseInt(e.target.value))}
        />
      </div>

      <div style={styles.field}>
        <label style={styles.label}>异步任务超时 (ms)</label>
        <input
          style={styles.input}
          type="number"
          value={config.taskTimeoutMs || 1800000}
          onChange={e => handleChange('taskTimeoutMs', parseInt(e.target.value))}
        />
      </div>

      <div style={styles.field}>
        <label style={styles.label}>最大并发 Workers</label>
        <input
          style={styles.input}
          type="number"
          value={config.maxWorkers || 4}
          onChange={e => handleChange('maxWorkers', parseInt(e.target.value))}
        />
      </div>

      <div style={styles.field}>
        <label style={styles.label}>单次验证最大成本 (USD)</label>
        <input
          style={styles.input}
          type="number"
          step="0.01"
          value={config.maxCostPerVerification || 0}
          onChange={e => handleChange('maxCostPerVerification', parseFloat(e.target.value))}
        />
      </div>

      <div style={styles.field}>
        <label style={styles.label}>输入 Token 单价 (USD/1k)</label>
        <input
          style={styles.input}
          type="number"
          step="0.0001"
          value={config.costPer1kInputTokens || 0}
          onChange={e => handleChange('costPer1kInputTokens', parseFloat(e.target.value))}
        />
      </div>

      <div style={styles.field}>
        <label style={styles.label}>输出 Token 单价 (USD/1k)</label>
        <input
          style={styles.input}
          type="number"
          step="0.0001"
          value={config.costPer1kOutputTokens || 0}
          onChange={e => handleChange('costPer1kOutputTokens', parseFloat(e.target.value))}
        />
      </div>

      <div style={styles.field}>
        <label style={styles.fieldCheckbox}>
          <input
            type="checkbox"
            checked={config.promptSection !== false}
            onChange={e => handleChange('promptSection', e.target.checked)}
          />
          注入使用策略到 System Prompt
        </label>
      </div>

      <div style={styles.field}>
        <button style={styles.button} onClick={handleSave}>保存配置</button>
      </div>
    </div>
  )
}

export function activateClient(ctx: any) {
  activate(ctx)
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '16px',
    fontFamily: 'system-ui, sans-serif',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '16px',
    paddingBottom: '12px',
    borderBottom: '1px solid #e0e0e0',
  },
  title: {
    margin: 0,
    fontSize: '18px',
    fontWeight: 600,
  },
  badge: {
    background: '#e3f2fd',
    color: '#1976d2',
    padding: '2px 8px',
    borderRadius: '12px',
    fontSize: '12px',
    fontWeight: 500,
  },
  backButton: {
    background: 'none',
    border: 'none',
    color: '#1976d2',
    cursor: 'pointer',
    fontSize: '14px',
    padding: '4px 8px',
  },
  empty: {
    color: '#999',
    textAlign: 'center',
    padding: '32px',
    margin: 0,
  },
  history: {
    flex: 1,
    overflow: 'auto',
  },
  list: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '10px 12px',
    borderBottom: '1px solid #f0f0f0',
    cursor: 'pointer',
    transition: 'background 0.1s',
  },
  runType: {
    fontWeight: 500,
    minWidth: '100px',
  },
  runTime: {
    color: '#666',
    fontSize: '12px',
    minWidth: '80px',
  },
  runModel: {
    color: '#999',
    fontSize: '12px',
    flex: 1,
  },
  detail: {
    flex: 1,
    overflow: 'auto',
  },
  pre: {
    margin: 0,
    fontSize: '12px',
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  settingsContainer: {
    padding: '16px',
    maxWidth: '600px',
  },
  settingsTitle: {
    marginTop: 0,
    marginBottom: '24px',
    fontSize: '18px',
    fontWeight: 600,
  },
  field: {
    marginBottom: '16px',
  },
  label: {
    display: 'block',
    marginBottom: '6px',
    fontSize: '14px',
    fontWeight: 500,
    color: '#333',
  },
  input: {
    width: '100%',
    padding: '8px 12px',
    border: '1px solid #ddd',
    borderRadius: '6px',
    fontSize: '14px',
    boxSizing: 'border-box',
  },
  fieldCheckbox: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  button: {
    background: '#1976d2',
    color: 'white',
    border: 'none',
    padding: '10px 24px',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: 500,
    cursor: 'pointer',
  },
}