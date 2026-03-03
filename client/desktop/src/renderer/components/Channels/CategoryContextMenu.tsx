import React from 'react';
import { Pencil, Trash2, FolderOpen } from 'lucide-react';
import { ChannelGroup } from '../../types/chat';
import ContextMenu from '../ui/ContextMenu';

interface CategoryContextMenuProps {
  group: ChannelGroup;
  position: { x: number; y: number };
  onClose: () => void;
  onEditCategory: (group: ChannelGroup) => void;
  onDeleteCategory: (group: ChannelGroup) => void;
}

const CategoryContextMenu: React.FC<CategoryContextMenuProps> = ({
  group,
  position,
  onClose,
  onEditCategory,
  onDeleteCategory,
}) => {
  return (
    <ContextMenu position={position} onClose={onClose}>
      <ContextMenu.Header>
        <FolderOpen size={14} />
        <span style={{ marginLeft: 6, fontWeight: 600 }}>{group.name}</span>
      </ContextMenu.Header>

      <ContextMenu.Separator />

      <ContextMenu.Item
        icon={<Pencil size={16} />}
        label="Edit Category"
        onClick={() => {
          onEditCategory(group);
          onClose();
        }}
      />

      <ContextMenu.Item
        icon={<Trash2 size={16} />}
        label="Delete Category"
        danger
        onClick={() => {
          onDeleteCategory(group);
          onClose();
        }}
      />
    </ContextMenu>
  );
};

export default CategoryContextMenu;
