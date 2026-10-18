-- ABI Explorer for Neovim: the language server (hovers, inlay hints) and
-- `:AbiLayout`, a split showing the layout of the struct at the cursor.
--
--   require('abi-explorer').setup()

local M = {}

local CLIENT_NAME = 'abi_explorer'
local DEBOUNCE_MS = 150

local split = { buffer = nil, window = nil, source = nil }
local timer = nil

--- Bits as bytes when whole: `4 B`, else `3 bits`.
local function size(bits)
  if bits % 8 == 0 then
    return (bits / 8) .. ' B'
  end
  return bits .. ' bits'
end

--- The record's summary line, then the server's text layout: byte map and member table.
local function record_lines(record)
  local summary = { record.kind .. ' ' .. record.name, size(record.sizeBits), 'align ' .. record.alignBits / 8 }
  if record.paddingBytes and record.paddingBytes > 0 then
    table.insert(summary, record.paddingBytes .. ' B padding')
  end
  local lines = { table.concat(summary, ' · '), '' }
  for _, line in ipairs(vim.split(record.text or '', '\n')) do
    table.insert(lines, '  ' .. line)
  end
  return lines
end

local function show(lines)
  vim.bo[split.buffer].modifiable = true
  vim.api.nvim_buf_set_lines(split.buffer, 0, -1, false, lines)
  vim.bo[split.buffer].modifiable = false
end

local function refresh()
  if not (split.window and vim.api.nvim_win_is_valid(split.window)) then
    return
  end
  local source = vim.api.nvim_get_current_buf()
  if source == split.buffer then
    return
  end
  local client = vim.lsp.get_clients({ bufnr = source, name = CLIENT_NAME })[1]
  if not client then
    return
  end
  split.source = source
  local params = vim.lsp.util.make_position_params(0, client.offset_encoding)
  params.includeText = true
  client:request('abiExplorer/layout', params, function(err, result)
    if err or not result or not vim.api.nvim_buf_is_valid(split.buffer) then
      return
    end
    if #result.records == 0 then
      show({ result.state == 'analyzing' and 'Analyzing…' or (result.message or 'No layouts.') })
      return
    end
    -- The record at the cursor; its member there is marked in the text.
    local record = result.records[1]
    for _, candidate in ipairs(result.records) do
      if result.selection and candidate.id == result.selection.recordId then
        record = candidate
      end
    end
    local lines = record_lines(record)
    if result.context then
      table.insert(lines, '')
      table.insert(lines, result.context.triple .. ' · ' .. result.context.commandSource)
    end
    show(lines)
  end, source)
end

local function schedule_refresh()
  if timer then
    timer:stop()
  end
  timer = vim.defer_fn(refresh, DEBOUNCE_MS)
end

--- Opens the layout split, or closes it when open.
function M.toggle()
  if split.window and vim.api.nvim_win_is_valid(split.window) then
    vim.api.nvim_win_close(split.window, true)
    split.window = nil
    return
  end
  local previous = vim.api.nvim_get_current_win()
  split.buffer = split.buffer and vim.api.nvim_buf_is_valid(split.buffer) and split.buffer or vim.api.nvim_create_buf(false, true)
  vim.bo[split.buffer].filetype = 'abilayout'
  vim.cmd('botright vertical 72 split')
  split.window = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(split.window, split.buffer)
  vim.wo[split.window].number = false
  vim.wo[split.window].wrap = false
  vim.api.nvim_set_current_win(previous)
  refresh()
end

function M.setup(opts)
  opts = opts or {}
  vim.lsp.config(CLIENT_NAME, opts.lsp or {})
  vim.lsp.enable(CLIENT_NAME)

  local group = vim.api.nvim_create_augroup('AbiExplorer', { clear = true })
  vim.api.nvim_create_autocmd('LspAttach', {
    group = group,
    callback = function(event)
      local client = vim.lsp.get_client_by_id(event.data.client_id)
      if client and client.name == CLIENT_NAME and opts.inlay_hints ~= false then
        vim.lsp.inlay_hint.enable(true, { bufnr = event.buf })
      end
    end,
  })
  vim.api.nvim_create_autocmd({ 'CursorMoved', 'BufEnter' }, { group = group, callback = schedule_refresh })
  vim.lsp.handlers['abiExplorer/layoutsChanged'] = function()
    schedule_refresh()
  end
  vim.api.nvim_create_user_command('AbiLayout', M.toggle, { desc = 'Toggle the struct layout split' })
end

return M
