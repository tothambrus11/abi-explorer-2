-- ABI Explorer for Neovim: the language server (hovers, code actions), dots in
-- each member's colour before its name, and `:AbiLayout`, a split showing the
-- web explorer's layout view of the struct at the cursor, drawn in Unicode.
--
--   require('abi-explorer').setup()

local M = {}

local CLIENT_NAME = 'abi_explorer'
local DEBOUNCE_MS = 150
local NAMESPACE = vim.api.nvim_create_namespace('abi_explorer')
local DOTS = vim.api.nvim_create_namespace('abi_explorer_dots')
local MARKS = vim.api.nvim_create_namespace('abi_explorer_marks')

-- The web explorer's colours (editors/shared/src/layoutModel.ts, a test checks):
-- Nocturne's members on a dark background, the light themes' on a light one.
local MEMBER_COLORS = {
  dark = {
    ['c-1'] = '#82aaff', ['c-2'] = '#f78c6c', ['c-3'] = '#7fdbca', ['c-4'] = '#ffcb6b',
    ['c-5'] = '#ff869a', ['c-6'] = '#addb67', ['c-7'] = '#c792ea', ['c-8'] = '#ef5350',
    ['c-special'] = '#5f6b8a',
  },
  light = {
    ['c-1'] = '#3b6fd4', ['c-2'] = '#e0742b', ['c-3'] = '#21a58a', ['c-4'] = '#d9a400',
    ['c-5'] = '#d65f9b', ['c-6'] = '#4f9d2f', ['c-7'] = '#6c4bc9', ['c-8'] = '#d94a4a',
    ['c-special'] = '#9a9a94',
  },
}
-- Its neutrals: Nocturne's, and the light default's.
local NEUTRALS = {
  dark = { muted = '#898781', grid = '#2c2c2a', baseline = '#383835', accent = '#3987e5', ink = '#ffffff' },
  light = { muted = '#898781', grid = '#e1e0d9', baseline = '#c3c2b7', accent = '#2a78d6', ink = '#0b0b0b' },
}

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

local function mode()
  return vim.o.background == 'light' and 'light' or 'dark'
end

--- A colour name from the server (`c-3`, `muted`, `text`…) as `#rrggbb`, or nil for the theme's own.
local function color(name)
  if name == nil or name == vim.NIL or name == 'text' then
    return nil
  end
  return MEMBER_COLORS[mode()][name] or NEUTRALS[mode()][name]
end

--- `color` mixed over the editor's background, `amount` of it: the web's translucent tints.
local function tint(hex, amount)
  local normal = vim.api.nvim_get_hl(0, { name = 'Normal', link = false })
  local ground = normal.bg and string.format('#%06x', normal.bg) or (mode() == 'light' and '#ffffff' or '#1a1a19')
  local function channel(value, index)
    return tonumber(value:sub(index, index + 1), 16)
  end
  local parts = {}
  for _, index in ipairs({ 2, 4, 6 }) do
    table.insert(parts, math.floor(channel(hex, index) * amount + channel(ground, index) * (1 - amount) + 0.5))
  end
  return string.format('#%02x%02x%02x', parts[1], parts[2], parts[3])
end

local defined = {}

--- The highlight group for a coloured run: foreground, background and style, defined on first use.
--- `default = true` leaves any the user defined alone.
local function group(fg, bg, style)
  style = style ~= vim.NIL and style or nil
  local name = ('AbiExplorer_' .. (fg ~= vim.NIL and fg or 'none') .. '_' .. (bg ~= vim.NIL and bg or 'none') .. '_' .. (style or 'plain'))
    :gsub('[^%w_]', '_')
  if not defined[name] then
    local spec = { default = true, fg = color(fg), bg = color(bg) }
    if style == 'bold' then
      spec.bold = true
    elseif style == 'lit' then
      -- The web outlines the member at hand; a terminal underlines it, in the page's ink.
      spec.bold = true
      spec.underline = true
      spec.sp = NEUTRALS[mode()].ink
    elseif style == 'lit-row' then
      spec.bg = tint(NEUTRALS[mode()].accent, 0.12)
    end
    if fg == 'text' then
      spec.fg = nil
    end
    vim.api.nvim_set_hl(0, name, spec)
    defined[name] = true
  end
  return name
end

local function define_highlights()
  defined = {}
  -- The web's editor marks for a hovered member: the line tinted, the name more strongly.
  vim.api.nvim_set_hl(0, 'AbiExplorerLine', { default = true, bg = tint(NEUTRALS[mode()].accent, 0.14) })
  vim.api.nvim_set_hl(0, 'AbiExplorerName', { default = true, bg = tint(NEUTRALS[mode()].accent, 0.30) })
  vim.api.nvim_set_hl(0, 'AbiExplorerTab', { default = true, fg = NEUTRALS[mode()].muted })
  vim.api.nvim_set_hl(0, 'AbiExplorerTabSelected', { default = true, fg = NEUTRALS[mode()].accent, bold = true, underline = true })
  vim.api.nvim_set_hl(0, 'AbiExplorerMuted', { default = true, fg = NEUTRALS[mode()].muted })
  vim.api.nvim_set_hl(0, 'AbiExplorerTitle', { default = true, bold = true })
end

--- Colours `colors` (the server's `textColors`) into `buffer`, `offset` lines down.
local function colorize(buffer, colors, offset)
  for _, run in ipairs(colors or {}) do
    local line, start, finish, fg, bg, style = run[1], run[2], run[3], run[4], run[5], run[6]
    vim.api.nvim_buf_set_extmark(buffer, NAMESPACE, offset + line, start, {
      end_col = finish,
      hl_group = group(fg, bg, style),
      priority = style == 'lit-row' and 90 or 110,
    })
  end
end

local split = { buffer = nil, window = nil, source = nil, result = nil, tabs = {}, rows = {}, open = {} }
local timer = vim.uv.new_timer()
-- Numbers each layout request, so a slow answer to an older one is dropped.
local request_number = 0

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

local function size(bits)
  if bits % 8 == 0 then
    return (bits / 8) .. ' B'
  end
  return bits .. ' b'
end

--- A dot in each member's colour before its name, as the web explorer's editor draws;
--- a ring for a compound member that has no one colour.
local function draw_dots(buffer, records)
  vim.api.nvim_buf_clear_namespace(buffer, DOTS, 0, -1)
  -- One dot a name: a template's instantiations share their members' names.
  local seen = {}
  for _, record in ipairs(records) do
    for _, member in ipairs(record.members) do
      local range = member.nameRange
      local key = range and range ~= vim.NIL and (range.start.line .. ':' .. range.start.character)
      if key and not seen[key] then
        seen[key] = true
        local slot
        if member.group ~= vim.NIL and member.group ~= nil then
          slot = record.layout.groups[member.group + 1].color
        else
          slot = record.layout.leaves[member.leaves[1] + 1].color
        end
        local ring = slot == nil or slot == vim.NIL
        local line = vim.api.nvim_buf_get_lines(buffer, range.start.line, range.start.line + 1, false)[1]
        if line then
          pcall(vim.api.nvim_buf_set_extmark, buffer, DOTS, range.start.line, vim.str_byteindex(line, 'utf-16', range.start.character, false), {
            virt_text = { { ring and '○ ' or '● ', ring and 'AbiExplorerMuted' or group(slot, vim.NIL, vim.NIL) } },
            virt_text_pos = 'inline',
          })
        end
      end
    end
  end
end

--- Marks `range` in the source as the web marks a hovered member; nil clears.
local function mark_source(range)
  local source = split.source
  if not (source and vim.api.nvim_buf_is_valid(source)) then
    return
  end
  vim.api.nvim_buf_clear_namespace(source, MARKS, 0, -1)
  if not range or range == vim.NIL then
    return
  end
  local line = vim.api.nvim_buf_get_lines(source, range.start.line, range.start.line + 1, false)[1]
  if not line then
    return
  end
  vim.api.nvim_buf_set_extmark(source, MARKS, range.start.line, 0, { line_hl_group = 'AbiExplorerLine' })
  vim.api.nvim_buf_set_extmark(source, MARKS, range.start.line, vim.str_byteindex(line, 'utf-16', range.start.character, false), {
    end_col = vim.str_byteindex(line, 'utf-16', range['end'].character, false),
    hl_group = 'AbiExplorerName',
  })
end

--- Puts the cursor on `range`: in the source buffer, or in the file `uri` names.
local function reveal(range, uri)
  local window = vim.fn.win_findbuf(split.source or -1)[1]
  if not window then
    return
  end
  vim.api.nvim_set_current_win(window)
  if uri then
    vim.cmd.edit(vim.fn.fnameescape(vim.uri_to_fname(uri)))
  end
  local line = vim.api.nvim_buf_get_lines(0, range.start.line, range.start.line + 1, false)[1] or ''
  vim.api.nvim_win_set_cursor(0, { range.start.line + 1, vim.str_byteindex(line, 'utf-16', range.start.character, false) })
end

local function show(lines)
  vim.bo[split.buffer].modifiable = true
  vim.api.nvim_buf_set_lines(split.buffer, 0, -1, false, lines)
  vim.bo[split.buffer].modifiable = false
  vim.api.nvim_buf_clear_namespace(split.buffer, NAMESPACE, 0, -1)
end

--- The split: the web's record tabs, then the record's title and the server's drawing.
local function draw(result, shown)
  local lines, tabs = {}, {}
  if result.message and result.message ~= vim.NIL then
    vim.list_extend(lines, { result.message, '' })
  end
  local tab_line = #lines
  local text = ''
  for _, record in ipairs(result.records) do
    local label = record.kind .. ' ' .. record.name .. ' ' .. size(record.sizeBits)
    if text ~= '' then
      text = text .. '  │  '
    end
    table.insert(tabs, { start = #text, finish = #text + #label, record = record })
    text = text .. label
  end
  table.insert(lines, text)
  table.insert(lines, '')
  table.insert(lines, shown.kind .. ' ' .. shown.name)
  table.insert(lines, '')
  local offset = #lines
  vim.list_extend(lines, vim.split(shown.text or '', '\n'))
  if result.context and result.context ~= vim.NIL then
    table.insert(lines, '')
    table.insert(lines, context_line(result.context))
  end
  show(lines)
  for _, tab in ipairs(tabs) do
    vim.api.nvim_buf_set_extmark(split.buffer, NAMESPACE, tab_line, tab.start, {
      end_col = tab.finish,
      hl_group = tab.record.id == shown.id and 'AbiExplorerTabSelected' or 'AbiExplorerTab',
    })
  end
  vim.api.nvim_buf_set_extmark(split.buffer, NAMESPACE, offset - 2, 0, { end_col = #lines[offset - 1], hl_group = 'AbiExplorerTitle' })
  if result.context and result.context ~= vim.NIL then
    vim.api.nvim_buf_set_extmark(split.buffer, NAMESPACE, #lines - 1, 0, { end_col = #lines[#lines], hl_group = 'AbiExplorerMuted' })
  end
  colorize(split.buffer, shown.textColors, offset)
  split.tabs = { line = tab_line, entries = tabs }
  split.rows = {}
  for _, row in ipairs(shown.textRows or {}) do
    split.rows[offset + row.line] = row
  end
  split.shown = shown
end

local function refresh()
  local source = vim.api.nvim_get_current_buf()
  if source == split.buffer then
    return
  end
  local client = vim.lsp.get_clients({ bufnr = source, name = CLIENT_NAME })[1]
  if not client then
    return
  end
  local open = split.window and vim.api.nvim_win_is_valid(split.window)
  local params = vim.lsp.util.make_position_params(0, client.offset_encoding)
  params.includeText = open or nil
  params.open = next(split.open) and split.open or nil
  request_number = request_number + 1
  local number = request_number
  client:request('abiExplorer/layout', params, function(err, result)
    if number ~= request_number or not vim.api.nvim_buf_is_valid(source) then
      return
    end
    if result and result.records then
      -- The record at the cursor gets the dots, as the web marks the record it shows.
      local selection = result.selection ~= vim.NIL and result.selection or nil
      draw_dots(source, vim.tbl_filter(function(record)
        return selection ~= nil and record.id == selection.recordId
      end, result.records))
    end
    if not (open and vim.api.nvim_buf_is_valid(split.buffer)) then
      return
    end
    split.source = source
    split.result = result
    if err or not result then
      show({ 'The layout request failed: ' .. (err and err.message or 'no answer') })
      return
    end
    if #result.records == 0 then
      local message = result.message ~= vim.NIL and result.message or nil
      show({ message or (result.state == 'analyzing' and 'Analyzing…' or 'No layouts yet.') })
      return
    end
    -- The record at the cursor, as the web's tabs follow the caret.
    local selection = result.selection ~= vim.NIL and result.selection or nil
    local shown = result.records[1]
    for _, candidate in ipairs(result.records) do
      if selection and candidate.id == selection.recordId then
        shown = candidate
      end
    end
    draw(result, shown)
  end, source)
end

local function schedule_refresh()
  timer:stop()
  timer:start(DEBOUNCE_MS, 0, vim.schedule_wrap(refresh))
end

--- `<CR>` in the split: a tab opens its record, a row with others inside opens or
--- shuts, any other row goes to its member in the source.
local function activate()
  local line, column = unpack(vim.api.nvim_win_get_cursor(0))
  if split.tabs and line - 1 == split.tabs.line then
    for _, tab in ipairs(split.tabs.entries) do
      if column >= tab.start and column < tab.finish and tab.record.nameRange ~= vim.NIL then
        reveal(tab.record.nameRange)
      end
    end
    return
  end
  local row = split.rows[line - 1]
  if not row then
    return
  end
  if row.opens then
    local name = split.shown.name
    local ids = split.open[name] or {}
    local at = vim.tbl_contains(ids, row.id)
    split.open[name] = vim.tbl_filter(function(id)
      return id ~= row.id
    end, ids)
    if not at then
      table.insert(split.open[name], row.id)
    end
    local window = vim.fn.win_findbuf(split.source or -1)[1]
    if window then
      vim.api.nvim_win_call(window, refresh)
    end
  elseif row.range ~= vim.NIL then
    reveal(row.range)
  end
end

--- `gd` in the split: on a compound member, the record it is an instance of
--- (the web's inspect); on anything else, its source.
local function inspect()
  local row = split.rows[vim.api.nvim_win_get_cursor(0)[1] - 1]
  if not row then
    return activate()
  end
  local ref = tonumber(row.id:sub(2))
  if row.id:sub(1, 1) == 'g' then
    local target = split.shown.layout.groups[ref + 1]
    for _, record in ipairs(split.result.records) do
      if record.id == target.recordId and record.nameRange ~= vim.NIL then
        return reveal(record.nameRange)
      end
    end
    if target.declaration ~= vim.NIL then
      return reveal(target.declaration.range, target.declaration.uri)
    end
  end
  if row.range ~= vim.NIL then
    reveal(row.range)
  end
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
  if not (split.buffer and vim.api.nvim_buf_is_valid(split.buffer)) then
    split.buffer = vim.api.nvim_create_buf(false, true)
    vim.keymap.set('n', '<CR>', activate, { buffer = split.buffer, desc = 'Open the record, row or member' })
    vim.keymap.set('n', 'gd', inspect, { buffer = split.buffer, desc = "Go to a member's record, or its source" })
    vim.api.nvim_create_autocmd('CursorMoved', {
      buffer = split.buffer,
      callback = function()
        local row = split.rows[vim.api.nvim_win_get_cursor(0)[1] - 1]
        mark_source(row and row.range)
      end,
    })
    vim.api.nvim_create_autocmd('BufLeave', {
      buffer = split.buffer,
      callback = function()
        mark_source(nil)
      end,
    })
  end
  vim.bo[split.buffer].filetype = 'abilayout'
  vim.cmd('botright vertical 92 split')
  split.window = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(split.window, split.buffer)
  vim.wo[split.window].number = false
  vim.wo[split.window].relativenumber = false
  vim.wo[split.window].signcolumn = 'no'
  vim.wo[split.window].wrap = false
  vim.wo[split.window].cursorline = true
  vim.api.nvim_set_current_win(previous)
  refresh()
end

function M.setup(opts)
  opts = opts or {}
  define_highlights()
  vim.lsp.config(CLIENT_NAME, opts.lsp or {})
  vim.lsp.enable(CLIENT_NAME)

  local augroup = vim.api.nvim_create_augroup('AbiExplorer', { clear = true })
  -- A colour scheme loaded later clears the groups, and a new background changes the palette.
  vim.api.nvim_create_autocmd('ColorScheme', { group = augroup, callback = define_highlights })
  vim.api.nvim_create_autocmd('OptionSet', { group = augroup, pattern = 'background', callback = define_highlights })
  vim.api.nvim_create_autocmd({ 'CursorMoved', 'BufEnter' }, { group = augroup, callback = schedule_refresh })
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
