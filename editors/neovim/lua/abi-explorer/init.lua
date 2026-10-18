-- ABI Explorer for Neovim: the language server (hovers, inlay hints) and
-- `:AbiLayout`, a split showing the layout of the struct at the cursor.
--
--   require('abi-explorer').setup()

local M = {}

local CLIENT_NAME = 'abi_explorer'
local DEBOUNCE_MS = 150
local NAMESPACE = vim.api.nvim_create_namespace('abi_explorer')

-- The member colours and letters of editors/shared/src/layoutModel.ts, so the
-- split matches the hovers and panels of the other editors (a test checks).
local PALETTE = { '#4e79a7', '#f28e2b', '#59a14f', '#b07aa1', '#e15759', '#76b7b2', '#edc948', '#9c755f' }
local PADDING_COLOR = '#8a8a8a'

-- `:AbiTarget`'s completions: the targets VS Code's Choose Target offers.
local TARGETS = {
  'x86_64-linux-gnu',
  'x86_64-pc-windows-msvc',
  'i686-linux-gnu',
  'aarch64-linux-gnu',
  'arm64-apple-macosx',
  'armv7-unknown-linux-gnueabihf',
  'thumbv7em-none-eabi',
  'riscv32-unknown-elf',
  'riscv64-linux-gnu',
  'wasm32-wasi',
  'avr-none',
  'powerpc-linux-gnu',
}
local LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
local PADDING_DOT = '·'
local MARKER = '▶'

--- Highlight groups per palette colour: `AbiExplorerMember1` (a filled cell),
--- `AbiExplorerMemberFaded1` (another member than the one at the cursor).
--- `default = true` leaves any the user defined alone.
local function define_highlights()
  for index, color in ipairs(PALETTE) do
    vim.api.nvim_set_hl(0, 'AbiExplorerMember' .. index, { default = true, bg = color, fg = '#ffffff', bold = true })
    vim.api.nvim_set_hl(0, 'AbiExplorerMemberFaded' .. index, { default = true, fg = color })
  end
  vim.api.nvim_set_hl(0, 'AbiExplorerPadding', { default = true, fg = PADDING_COLOR })
  vim.api.nvim_set_hl(0, 'AbiExplorerSelected', { default = true, link = 'CursorLine' })
end

--- The group for a cell or swatch: `letter` names the member, `·` is padding.
local function cell_group(token, highlighted)
  if token == PADDING_DOT then
    return 'AbiExplorerPadding'
  end
  local index = LETTERS:find(token, 1, true)
  if not index then
    return nil
  end
  local color = (index - 1) % #PALETTE + 1
  local faded = highlighted ~= nil and highlighted ~= index - 1
  return (faded and 'AbiExplorerMemberFaded' or 'AbiExplorerMember') .. color
end

--- Colours the server's text layout in place: the byte map's cells, and the
--- swatch letter of each member table row. `highlighted` is the 0-based index
--- of the member at the cursor; its bytes and swatch are filled, and the others
--- are coloured text (all map cells are filled when no member is at the cursor).
local function colorize(buffer, lines, highlighted)
  vim.api.nvim_buf_clear_namespace(buffer, NAMESPACE, 0, -1)
  local function mark(row, start, finish, group)
    vim.api.nvim_buf_set_extmark(buffer, NAMESPACE, row, start, { end_col = finish, hl_group = group })
  end
  for row, line in ipairs(lines) do
    local label_end = line:match('^%s*%d+  ()')
    if label_end and not line:match('^[%s%d]*$') then
      -- A byte map row: `  8  c c · ·`.
      for start, token in line:sub(label_end):gmatch('()(%S+)') do
        local group = cell_group(token, highlighted)
        local from = label_end + start - 2
        if group then
          mark(row - 1, from, from + #token, group)
        end
      end
    else
      -- A member table row: `  ▶c  checksum  8  2 B  short`.
      local first = line:find('%S')
      if first and line:sub(first, first + #MARKER - 1) == MARKER then
        -- The row at the cursor, but not its swatch: a line highlight would cover the swatch's colour.
        vim.api.nvim_buf_set_extmark(buffer, NAMESPACE, row - 1, first + #MARKER, {
          end_col = #line,
          hl_group = 'AbiExplorerSelected',
          hl_eol = true,
        })
        first = first + #MARKER
      end
      local token = first and (line:sub(first, first + #PADDING_DOT - 1) == PADDING_DOT and PADDING_DOT or line:sub(first, first))
      -- Only the member at the cursor gets a filled swatch; the others their colour as text.
      local swatch_group = token
        and line:sub(first + #token, first + #token + 1) == '  '
        and cell_group(token, highlighted or -1)
      if swatch_group then
        mark(row - 1, first - 1, first - 1 + #token, swatch_group)
      end
    end
  end
end

local split = { buffer = nil, window = nil }
local timer = vim.uv.new_timer()
-- Numbers each layout request, so a slow answer to an older one is dropped.
local request_number = 0

--- Bits as bytes when whole: `4 B`, else `3 bits`.
local function size(bits)
  if bits % 8 == 0 then
    return (bits / 8) .. ' B'
  end
  return bits .. ' bits'
end

--- Where the layouts come from, and anything that makes them less certain (as hovers say it).
local function context_line(context)
  local notes = { context.triple, context.commandSource }
  if context.commandInferred then
    table.insert(notes, 'flags borrowed from a neighbouring file')
  end
  local function errors(count)
    return count == 1 and '1 error' or (count .. ' errors')
  end
  if context.errorCount > 0 then
    table.insert(notes, errors(context.errorCount) .. ' in this file, so layouts may be incomplete')
  end
  if (context.otherErrorCount or 0) > 0 then
    table.insert(notes, errors(context.otherErrorCount) .. ' in its headers or flags')
  end
  if context.firstError and context.firstError ~= vim.NIL then
    table.insert(notes, context.firstError)
  end
  if context.warning and context.warning ~= vim.NIL then
    table.insert(notes, context.warning)
  end
  return table.concat(notes, ' · ')
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

local function show(lines, highlighted)
  vim.bo[split.buffer].modifiable = true
  vim.api.nvim_buf_set_lines(split.buffer, 0, -1, false, lines)
  vim.bo[split.buffer].modifiable = false
  colorize(split.buffer, lines, highlighted)
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
  local params = vim.lsp.util.make_position_params(0, client.offset_encoding)
  params.includeText = true
  request_number = request_number + 1
  local number = request_number
  client:request('abiExplorer/layout', params, function(err, result)
    if number ~= request_number or not vim.api.nvim_buf_is_valid(split.buffer) then
      return
    end
    if err or not result then
      show({ 'The layout request failed: ' .. (err and err.message or 'no answer') })
      return
    end
    if #result.records == 0 then
      local message = result.message ~= vim.NIL and result.message or nil
      show({ message or (result.state == 'analyzing' and 'Analyzing…' or 'No layouts yet.') })
      return
    end
    -- The record at the cursor, and its member there: marked in the text, bright in the map.
    local selection = result.selection ~= vim.NIL and result.selection or nil
    local record = result.records[1]
    for _, candidate in ipairs(result.records) do
      if selection and candidate.id == selection.recordId then
        record = candidate
      end
    end
    local highlighted = selection
      and selection.recordId == record.id
      and selection.memberIndex ~= vim.NIL
      and selection.memberIndex
      or nil
    local lines = record_lines(record)
    if result.message and result.message ~= vim.NIL then
      table.insert(lines, 1, result.message)
      table.insert(lines, 2, '')
    end
    if result.context and result.context ~= vim.NIL then
      table.insert(lines, '')
      table.insert(lines, context_line(result.context))
    end
    show(lines, highlighted)
  end, source)
end

local function schedule_refresh()
  timer:stop()
  timer:start(DEBOUNCE_MS, 0, vim.schedule_wrap(refresh))
end

-- For tests: the colouring of the split, on any buffer.
M.colorize = colorize

--- Lays files out for `triple` instead of the project's own target, or for the
--- project's own again when `triple` is empty, restarting the server.
function M.set_target(triple)
  triple = vim.trim(triple or '')
  vim.lsp.config(CLIENT_NAME, { init_options = { target = triple ~= '' and triple or vim.NIL } })
  local buffers = {}
  for _, client in ipairs(vim.lsp.get_clients({ name = CLIENT_NAME })) do
    vim.list_extend(buffers, vim.tbl_keys(client.attached_buffers))
    client:stop(true)
  end
  -- Started afresh, with the new options, for every buffer the old one served.
  vim.defer_fn(function()
    for _, buffer in ipairs(buffers) do
      if vim.api.nvim_buf_is_valid(buffer) then
        vim.api.nvim_exec_autocmds('FileType', { buffer = buffer })
      end
    end
  end, 100)
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
  -- Wrapped at words, so a long note or type stays readable in a narrow split.
  vim.wo[split.window].wrap = true
  vim.wo[split.window].linebreak = true
  vim.wo[split.window].breakindent = true
  vim.api.nvim_set_current_win(previous)
  refresh()
end

function M.setup(opts)
  opts = opts or {}
  define_highlights()
  vim.lsp.config(CLIENT_NAME, opts.lsp or {})
  vim.lsp.enable(CLIENT_NAME)

  local group = vim.api.nvim_create_augroup('AbiExplorer', { clear = true })
  -- A colour scheme loaded later clears the groups.
  vim.api.nvim_create_autocmd('ColorScheme', { group = group, callback = define_highlights })
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
  vim.api.nvim_create_user_command('AbiTarget', function(command)
    M.set_target(command.args)
  end, {
    nargs = '?',
    complete = function(lead)
      return vim.tbl_filter(function(triple)
        return vim.startswith(triple, lead)
      end, TARGETS)
    end,
    desc = "Lay structs out for a target triple, or the project's own with none",
  })
end

return M
