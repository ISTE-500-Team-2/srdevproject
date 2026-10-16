-- Printed/offline companions keep links to other repository documents usable.
function Link(link)
  if not link.target:match('^%a[%w+.-]*:') and not link.target:match('^#') then
    link.target = 'https://github.com/ISTE-500-Team-2/srdevproject/blob/main/docs/' .. link.target
  end
  return link
end
